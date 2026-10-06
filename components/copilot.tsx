"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  Bot,
  Check,
  Database,
  Eye,
  EyeOff,
  Globe,
  GraduationCap,
  HelpCircle,
  Send,
  Sliders,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
  BookmarkPlus,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import RecorderTranscriber from "@/components/recorder";
import { ChatTranscription } from "@/components/ChatTranscription";
import { PromptModal } from "@/components/PromptModal";
import { FLAGS, isCompletedOutput, type HistoryData } from "@/lib/types";
import { transcriptStateMachine, type UtteranceSegment } from "@/lib/transcriptStateMachine";
import { SESSION_INFO_EVENT, sessionManager } from "@/lib/sessionManager";
import { DEFAULT_PROMPT_RULES, PROMPT_RULES_VERSION, PROMPT_RULES_VERSION_STORAGE_KEY, PROMPT_STYLE_STORAGE_KEY } from "@/lib/utils";
import { setSettings, useAppSetting } from "@/lib/clientSettings";
import type { CompletionContextSnapshot, CompletionMetrics } from "@/lib/diagnostics/types";
import type { SessionInfo } from "@/lib/conversationTypes";
import { getCallPromptTemplate } from "@/lib/prompts";

const ReactMarkdown = dynamic(() => import("react-markdown").then((module) => module.default), { ssr: false });

const KnowledgePackManager = dynamic(
  () => import("@/components/KnowledgePackManager").then((module) => module.KnowledgePackManager),
  { ssr: false, loading: () => <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-xs text-slate-500">Loading Candidate Knowledge…</div> },
);
const QABankManager = dynamic(
  () => import("@/components/QABankManager").then((module) => module.QABankManager),
  { ssr: false, loading: () => <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-xs text-slate-500">Loading Q&A Bank…</div> },
);
const DiagnosticsDrawer = dynamic(
  () => import("@/components/DiagnosticsDrawer").then((module) => module.DiagnosticsDrawer),
  { ssr: false },
);
const QAHistoryManager = dynamic(
  () => import("@/components/QAHistoryManager").then((module) => module.QAHistoryManager),
  { ssr: false, loading: () => <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 text-xs text-slate-500">Loading answer review…</div> },
);
const LocalDataManager = dynamic(() => import("@/components/LocalDataManager").then(module => module.LocalDataManager), { ssr: false });

interface CopilotProps {
  addInSavedData: (data: HistoryData) => void;
}

interface Citation {
  sourceType: "web";
  title: string;
  source: string;
  url: string;
  contextSnippet: string;
}

interface SSEMessage {
  event: string;
  data: any;
}

function parseSSEBlock(block: string): SSEMessage | null {
  const lines = block.split("\n");
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

interface SlotState {
  runId?: string;
  requestId?: string;
  completed: boolean;
  completion: string;
  provider: string;
  model: string;
  streamStatus: string;
  metrics: CompletionMetrics | null;
  error: Error | null;
  done: boolean;
}

const emptySlot: SlotState = { completed: false, completion: "", provider: "", model: "", streamStatus: "", metrics: null, error: null, done: false };

function useLiveCompletion(
  body: { bg: string; flag: FLAGS; customRules: string },
  onAutoSave?: (data: HistoryData) => void,
) {
  const [slotA, setSlotA] = useState<SlotState>({ ...emptySlot });
  const [slotB, setSlotB] = useState<SlotState>({ ...emptySlot });
  const [isParallel, setIsParallel] = useState(false);
  const [primarySlot, setPrimarySlot] = useState<"a" | "b">("a");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [question, setQuestion] = useState("");
  const [questionConfidence, setQuestionConfidence] = useState<"high" | "medium" | "fallback">("fallback");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [metrics, setMetrics] = useState<CompletionMetrics | null>(null);
  const [contextSnapshot, setContextSnapshot] = useState<CompletionContextSnapshot | null>(null);
  const [streamStatus, setStreamStatus] = useState("");
  const [qaHistoryId, setQaHistoryId] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Record<string, { feedback?: "good" | "poor"; promoted?: boolean }>>({});
  const answerFeedback = qaHistoryId ? reviews[qaHistoryId]?.feedback || null : null;
  const answerPromoted = Boolean(qaHistoryId && reviews[qaHistoryId]?.promoted);
  const [historyActionStatus, setHistoryActionStatus] = useState("");
  const [historyActionBusy, setHistoryActionBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const reviewAbortRef = useRef<AbortController | null>(null);
  const actionRef = useRef(0);

  useEffect(() => () => {
    abortRef.current?.abort();
    reviewAbortRef.current?.abort();
    abortRef.current = null;
    actionRef.current += 1;
  }, []);

  const handleSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (isLoading || (abortRef.current && !abortRef.current.signal.aborted && !slotA.done && !slotB.done)) return;

    const sessionInfo = sessionManager.getSessionInfo();
    const questionBundle = sessionInfo?.callType === "taking_interview"
      ? transcriptStateMachine.getLatestCandidateResponseBundle() : transcriptStateMachine.getLatestQuestionBundle();
    const focusQuestion = questionBundle?.primaryAsk
      || transcriptStateMachine.getLatestQuestionContext()
      || transcriptStateMachine.getLatestInterviewerTurn()?.text || "";
    const recentTurns = body.flag === FLAGS.SUMMERIZER
      ? transcriptStateMachine.getRecentFinalizedTurns(100)
      : transcriptStateMachine.getRecentFinalizedTurns(16);
    if (body.flag === FLAGS.COPILOT && !focusQuestion) {
      const mode = getCallPromptTemplate(sessionInfo);
      setError(new Error(`No usable ${mode.remoteRole} context is available yet.`));
      return;
    }

    setQuestion(focusQuestion);
    setQuestionConfidence(questionBundle?.primaryAskConfidence || "fallback");
    setSlotA({ ...emptySlot });
    setSlotB({ ...emptySlot });
    setIsParallel(false);
    setPrimarySlot("a");
    setCitations([]);
    setMetrics(null);
    setContextSnapshot(null);
    setError(null);
    setQaHistoryId(null);
    setReviews({});
    reviewAbortRef.current?.abort();
    actionRef.current += 1;
    setHistoryActionBusy(false);
    setHistoryActionStatus("");
    setStreamStatus("Preparing context…");
    setIsLoading(true);

    const requestStarted = performance.now();
    let firstSseAt: number | null = null;
    let firstTextAt: number | null = null;
    const slotTtft: Record<string, number> = {};
    const pendingText: Record<string, string> = { a: "", b: "" };
    const fullText: Record<string, string> = { a: "", b: "" };
    const slotRuns: Record<string, { runId?: string; requestId?: string; provider?: string; model?: string; failed: boolean; saved: boolean }> = {
      a: { failed: false, saved: false }, b: { failed: false, saved: false },
    };
    let derivedQuestion = focusQuestion;
    const flushTimers: Record<string, ReturnType<typeof setTimeout> | null> = { a: null, b: null };
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const isCurrent = () => abortRef.current === controller && !controller.signal.aborted;

    const setSlotByKey = (slot: string) => slot === "a" ? setSlotA : setSlotB;

    const flushSlot = (slot: string) => {
      if (flushTimers[slot]) { clearTimeout(flushTimers[slot]!); flushTimers[slot] = null; }
      if (!isCurrent()) return;
      if (!pendingText[slot]) return;
      const next = pendingText[slot];
      pendingText[slot] = "";
      setSlotByKey(slot)((prev) => ({ ...prev, completion: prev.completion + next }));
    };

    const enqueueSlotText = (slot: string, text: string) => {
      if (text.trim() && slotTtft[slot] === undefined) {
        slotTtft[slot] = Math.round(performance.now() - requestStarted);
        setSlotByKey(slot)((previous) => ({ ...previous, metrics: { ...(previous.metrics || {}), clientTtftMs: slotTtft[slot] } }));
        if (firstTextAt === null) {
          firstTextAt = performance.now();
          setMetrics((previous) => ({ ...(previous || {}), clientTtftMs: Math.round(firstTextAt! - requestStarted) }));
        }
      }
      pendingText[slot] += text;
      fullText[slot] += text;
      if (flushTimers[slot]) return;
      flushTimers[slot] = setTimeout(() => { flushTimers[slot] = null; flushSlot(slot); }, 40);
    };

    const completeSlot = (slot: string, data: { runId?: string; status?: string; completed?: boolean }) => {
      flushSlot(slot);
      const run = slotRuns[slot];
      run.runId = data.runId || run.runId;
      const completed = isCompletedOutput(fullText[slot], true, run.failed, data);
      setSlotByKey(slot)((previous) => ({ ...previous, runId: run.runId, done: true, completed, streamStatus: "" }));
      if (!completed || !run.runId || run.saved || !isCurrent()) return;
      run.saved = true;
      setQaHistoryId((previous) => previous || run.runId!);
      onAutoSave?.({
        id: run.runId, createdAt: new Date().toISOString(), data: fullText[slot].trim(), question: derivedQuestion || undefined,
        tag: body.flag === FLAGS.SUMMERIZER ? "Summarizer" : sessionInfo?.callType === "taking_interview" ? "Interviewer Follow-up" : sessionInfo?.callType === "meeting" ? "Meeting Response" : "Interview Answer",
      });
    };

    try {
      const response = await fetch("/api/completion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          ...body,
          focusQuestion,
          questionBundle,
          recentTurns,
          memory: sessionManager.getMemory(),
          sessionInfo,
          sessionId: sessionManager.getSessionId(),
          ownerTabId: sessionManager.getOwnerTabId(),
          sessionStartedAt: sessionManager.getStartedAt(),
          sessionTurns: sessionManager.getPendingTurns(),
        }),
      });
      if (!isCurrent()) return;
      const clientResponseHeadersMs = Math.round(performance.now() - requestStarted);
      setMetrics((previous) => ({ ...(previous || {}), clientResponseHeadersMs }));

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.details || payload?.error || `Completion request failed (${response.status})`);
      }
      if (!response.body) throw new Error("The completion response did not contain a stream");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handleMessage = (message: SSEMessage) => {
        if (!isCurrent()) return;
        if (firstSseAt === null) {
          firstSseAt = performance.now();
          setMetrics((previous) => ({
            ...(previous || {}),
            clientFirstSseMs: Math.round(firstSseAt! - requestStarted),
          }));
        }

        const evt = message.event;

        // Parallel-mode events: delta_a, delta_b, meta_a, meta_b, etc.
        if (evt === "parallel_init") {
          const slots = message.data?.slots || [];
          setIsParallel(slots.length > 1);
          setPrimarySlot(slots[0]?.slot?.toUpperCase() === "B" ? "b" : "a");
          for (const available of slots) {
            const slot = available.slot?.toUpperCase() === "B" ? "b" : "a";
            Object.assign(slotRuns[slot], available);
            setSlotByKey(slot)((prev) => ({ ...prev, provider: available.provider, model: available.model, runId: available.runId, requestId: available.requestId }));
          }
          setMetrics((previous) => ({ ...(previous || {}), ...message.data }));
          return;
        }

        // Per-slot delta
        if (evt === "delta_a" || evt === "delta_b") {
          const slot = evt === "delta_a" ? "a" : "b";
          const text = String(message.data?.text || "");
          if (text) enqueueSlotText(slot, text);
          return;
        }

        // Per-slot meta
        if (evt === "meta_a" || evt === "meta_b") {
          const slot = evt === "meta_a" ? "a" : "b";
          Object.assign(slotRuns[slot], message.data);
          setSlotByKey(slot)((prev) => ({ ...prev, runId: message.data?.runId || prev.runId, requestId: message.data?.requestId || prev.requestId, provider: message.data?.provider || prev.provider, model: message.data?.model || prev.model }));
          return;
        }

        // Per-slot status
        if (evt === "status_a" || evt === "status_b") {
          const setter = evt === "status_a" ? setSlotA : setSlotB;
          setter((prev) => ({ ...prev, streamStatus: String(message.data?.message || "") }));
          return;
        }

        // Per-slot metrics
        if (evt === "metrics_a" || evt === "metrics_b") {
          const setter = evt === "metrics_a" ? setSlotA : setSlotB;
          const slot = evt === "metrics_a" ? "a" : "b";
          setter((prev) => ({ ...prev, metrics: { ...(prev.metrics || {}), ...message.data, ...(slotTtft[slot] === undefined ? {} : { clientTtftMs: slotTtft[slot] }) } }));
          return;
        }

        // Per-slot done
        if (evt === "done_a" || evt === "done_b") {
          const slot = evt === "done_a" ? "a" : "b";
          completeSlot(slot, message.data || {});
          return;
        }

        // Per-slot error
        if (evt === "error_a" || evt === "error_b") {
          slotRuns[evt === "error_a" ? "a" : "b"].failed = true;
          const setter = evt === "error_a" ? setSlotA : setSlotB;
          setter((prev) => ({ ...prev, completed: false, error: new Error(message.data?.message || "Stream failed"), done: true, streamStatus: "" }));
          return;
        }

        // Per-slot grounding
        if (evt === "grounding_a" || evt === "grounding_b") {
          // Grounding data not displayed in dual mode currently; could be extended later
          return;
        }

        // === Legacy single-model events (summarizer still uses streamToClient) ===
        switch (evt) {
          case "context": {
            const snapshot = message.data as CompletionContextSnapshot;
            setContextSnapshot(snapshot);
            if (snapshot?.question) {
              derivedQuestion = snapshot.question;
              setQuestion(snapshot.question);
            }
            const confidence = snapshot?.questionBundle?.primaryAskConfidence;
            if (confidence === "high" || confidence === "medium" || confidence === "fallback") setQuestionConfidence(confidence);
            break;
          }
          case "status":
            if (message.data?.message) setStreamStatus(String(message.data.message));
            break;
          case "meta":
            if (message.data?.question) {
              derivedQuestion = message.data.question;
              setQuestion(message.data.question);
            }
            setMetrics((previous) => ({ ...(previous || {}), ...message.data }));
            Object.assign(slotRuns.a, message.data);
            setSlotA((prev) => ({ ...prev, runId: message.data?.runId || prev.runId, requestId: message.data?.requestId || prev.requestId, provider: message.data?.provider || prev.provider, model: message.data?.model || prev.model }));
            break;
          case "delta": {
            const text = String(message.data?.text || "");
            if (text) enqueueSlotText("a", text);
            break;
          }
          case "sources":
            setCitations(Array.isArray(message.data?.citations) ? message.data.citations : []);
            break;
          case "metrics":
            setSlotA((previous) => ({ ...previous, metrics: { ...(previous.metrics || {}), ...message.data, ...(slotTtft.a === undefined ? {} : { clientTtftMs: slotTtft.a }) } }));
            setMetrics((previous) => ({
              ...(previous || {}),
              ...message.data,
            }));
            break;
          case "done":
            completeSlot("a", message.data || {});
            break;
          case "error":
            slotRuns.a.failed = true;
            setSlotA((previous) => ({ ...previous, done: true, completed: false }));
            setError(new Error(message.data?.details || message.data?.message || "The model stream was interrupted"));
            break;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (!isCurrent()) { await reader.cancel(); return; }
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary).trim();
          buffer = buffer.slice(boundary + 2);
          const message = parseSSEBlock(block);
          if (message) handleMessage(message);
        }
      }

      buffer += decoder.decode().replace(/\r\n/g, "\n");
      const trailing = parseSSEBlock(buffer.trim());
      if (trailing) handleMessage(trailing);
      flushSlot("a");
      flushSlot("b");
      setMetrics((previous) => ({
        ...(previous || {}),
        clientTotalMs: Math.round(performance.now() - requestStarted),
      }));
      setStreamStatus("");

      setSlotA((previous) => ({ ...previous, done: true, streamStatus: "" }));
      setSlotB((previous) => ({ ...previous, done: true, streamStatus: "" }));
    } catch (caught: any) {
      flushSlot("a");
      flushSlot("b");
      if (isCurrent() && caught?.name !== "AbortError") {
        setError(caught instanceof Error ? caught : new Error("Completion failed"));
      }
    } finally {
      for (const key of Object.keys(flushTimers)) if (flushTimers[key]) clearTimeout(flushTimers[key]!);
      if (isCurrent()) {
        setStreamStatus("");
        setIsLoading(false);
        setSlotA((previous) => ({ ...previous, done: true, streamStatus: "" }));
        setSlotB((previous) => ({ ...previous, done: true, streamStatus: "" }));
      }
    }
  }, [body, isLoading, onAutoSave, slotA.done, slotB.done]);

  const rateGeneratedAnswer = useCallback(async (feedback: "good" | "poor") => {
    if (!qaHistoryId || historyActionBusy || ![slotA, slotB].some((slot) => slot.runId === qaHistoryId && slot.completed)) return;
    const controller = abortRef.current;
    const reviewController = new AbortController();
    reviewAbortRef.current?.abort();
    reviewAbortRef.current = reviewController;
    const action = ++actionRef.current;
    const isCurrent = () => abortRef.current === controller && !controller?.signal.aborted && actionRef.current === action;
    setHistoryActionBusy(true);
    try {
      const response = await fetch("/api/qa-history", { method: "PATCH", signal: reviewController.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: qaHistoryId, feedback }) });
      const payload = await response.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(payload?.error || "Unable to save feedback");
      setReviews((previous) => ({ ...previous, [qaHistoryId]: { ...previous[qaHistoryId], feedback } }));
      setHistoryActionStatus(feedback === "good" ? "Approved for optional Q&A promotion." : "Marked poor; it will remain history only.");
    } catch (caught: any) {
      if (isCurrent()) setHistoryActionStatus(caught?.message || "Unable to save feedback");
    } finally { if (isCurrent()) setHistoryActionBusy(false); }
  }, [qaHistoryId, historyActionBusy, slotA, slotB]);

  const promoteGeneratedAnswer = useCallback(async () => {
    if (!qaHistoryId || answerFeedback !== "good" || historyActionBusy || ![slotA, slotB].some((slot) => slot.runId === qaHistoryId && slot.completed)) return;
    const controller = abortRef.current;
    const reviewController = new AbortController();
    reviewAbortRef.current?.abort();
    reviewAbortRef.current = reviewController;
    const action = ++actionRef.current;
    const isCurrent = () => abortRef.current === controller && !controller?.signal.aborted && actionRef.current === action;
    setHistoryActionBusy(true);
    try {
      const response = await fetch("/api/qa-history", { method: "PUT", signal: reviewController.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: qaHistoryId }) });
      const payload = await response.json().catch(() => ({}));
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(payload?.error || "Unable to promote answer");
      setReviews((previous) => ({ ...previous, [qaHistoryId]: { ...previous[qaHistoryId], promoted: true } }));
      setHistoryActionStatus(payload?.alreadyExists ? "A matching Prepared Q&A already exists." : "Promoted to Prepared Q&A.");
      window.dispatchEvent(new Event("qa-bank-updated"));
    } catch (caught: any) {
      if (isCurrent()) setHistoryActionStatus(caught?.message || "Unable to promote answer");
    } finally { if (isCurrent()) setHistoryActionBusy(false); }
  }, [qaHistoryId, answerFeedback, historyActionBusy, slotA, slotB]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    reviewAbortRef.current?.abort();
    abortRef.current = null;
    actionRef.current += 1;
    setHistoryActionBusy(false);
    setStreamStatus("");
    setIsLoading(false);
    setSlotA((previous) => ({ ...previous, done: true, streamStatus: "" }));
    setSlotB((previous) => ({ ...previous, done: true, streamStatus: "" }));
  }, []);

  const primary = primarySlot === "b" ? slotB : slotA;
  const diagnosticSlot = [slotA, slotB].find((slot) => slot.runId === qaHistoryId) || primary;
  const completion = primary.completion;
  const selectGeneratedAnswer = (id: string) => {
    if (![slotA, slotB].some((slot) => slot.runId === id && slot.completed)) return;
    reviewAbortRef.current?.abort();
    actionRef.current += 1;
    setQaHistoryId(id);
    setHistoryActionBusy(false);
    setHistoryActionStatus("");
  };

  return {
    completion,
    primary,
    selectGeneratedAnswer,
    slotA,
    slotB,
    isParallel,
    isLoading,
    error,
    question,
    questionConfidence,
    citations,
    metrics: metrics || diagnosticSlot.metrics ? { ...(metrics || {}), ...(diagnosticSlot.metrics || {}), provider: diagnosticSlot.provider, model: diagnosticSlot.model, requestId: diagnosticSlot.requestId } : null,
    contextSnapshot,
    streamStatus,
    qaHistoryId,
    answerFeedback,
    answerPromoted,
    historyActionStatus,
    historyActionBusy,
    rateGeneratedAnswer,
    promoteGeneratedAnswer,
    handleSubmit,
    stop,
  };
}

export function Copilot({ addInSavedData }: CopilotProps) {
  const [flag, setFlag] = useState<FLAGS>(FLAGS.COPILOT);
  const backgroundSetting = useAppSetting("bg", "");
  const promptSetting = useAppSetting(PROMPT_STYLE_STORAGE_KEY, DEFAULT_PROMPT_RULES);
  const promptVersion = useAppSetting(PROMPT_RULES_VERSION_STORAGE_KEY, 0);
  const bg = backgroundSetting.value;
  const customRules = promptSetting.value;
  const [settingsError, setSettingsError] = useState("");
  const [promptOpen, setPromptOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<UtteranceSegment[]>([]);
  const [hiddenBeforeSequence, setHiddenBeforeSequence] = useState(0);
  const [stealthMode, setStealthMode] = useState(false);
  const [activeSessionInfo, setActiveSessionInfo] = useState<SessionInfo | undefined>(undefined);
  const formRef = useRef<HTMLFormElement>(null);

  const requestBody = { bg, flag, customRules };
  const {
    completion,
    primary,
    selectGeneratedAnswer,
    slotA,
    slotB,
    isParallel,
    isLoading,
    error,
    question,
    questionConfidence,
    citations,
    metrics,
    contextSnapshot,
    streamStatus,
    qaHistoryId,
    answerFeedback,
    answerPromoted,
    historyActionStatus,
    historyActionBusy,
    rateGeneratedAnswer,
    promoteGeneratedAnswer,
    handleSubmit,
    stop,
  } = useLiveCompletion(requestBody, addInSavedData);

  useEffect(() => {
    setActiveSessionInfo(sessionManager.getSessionInfo());
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<SessionInfo | undefined>).detail;
      setActiveSessionInfo(detail);
    };
    window.addEventListener(SESSION_INFO_EVENT, handler as EventListener);
    return () => window.removeEventListener(SESSION_INFO_EVENT, handler as EventListener);
  }, []);

  useEffect(() => {
    if (!promptVersion.ready || promptVersion.value === PROMPT_RULES_VERSION) return;
    void setSettings({ [PROMPT_STYLE_STORAGE_KEY]: customRules.slice(0, 2500), [PROMPT_RULES_VERSION_STORAGE_KEY]: PROMPT_RULES_VERSION })
      .catch((reason) => setSettingsError(reason instanceof Error ? reason.message : "Unable to update prompt settings"));
  }, [promptVersion.ready, promptVersion.value, customRules]);

  useEffect(() => {
    const unsubscribeState = transcriptStateMachine.subscribe((messages) => {
      setChatMessages(messages.filter((message) => message.isInterim || message.sequenceId > hiddenBeforeSequence));
    });
    const unsubscribeTurn = transcriptStateMachine.onUtteranceCompleted((turn) => sessionManager.addTranscript(turn));
    return () => {
      unsubscribeState();
      unsubscribeTurn();
    };
  }, [hiddenBeforeSequence]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        formRef.current?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      }
      if (event.ctrlKey && event.shiftKey && event.code === "KeyC") setStealthMode((value) => !value);
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);

  const clearVisibleTranscript = () => {
    const latest = transcriptStateMachine.getLatestSequenceId();
    setHiddenBeforeSequence(latest);
    setChatMessages(
      transcriptStateMachine.getAllMessages().filter((message) => message.isInterim || message.sequenceId > latest),
    );
  };

  const saveBackground = (value: string) => {
    setSettingsError("");
    void backgroundSetting.setValue(value).catch((reason) => setSettingsError(reason instanceof Error ? reason.message : "Unable to save background"));
  };
  const saveRules = (value: string) => {
    setSettingsError("");
    void setSettings({ [PROMPT_STYLE_STORAGE_KEY]: value, [PROMPT_RULES_VERSION_STORAGE_KEY]: PROMPT_RULES_VERSION })
      .catch((reason) => setSettingsError(reason instanceof Error ? reason.message : "Unable to save prompt style"));
  };

  const callPrompt = getCallPromptTemplate(activeSessionInfo);
  const confidenceStyle = questionConfidence === "high"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
    : questionConfidence === "medium"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
      : "border-orange-500/30 bg-orange-500/10 text-orange-300";
  const showAskConfidence = activeSessionInfo?.callType !== "taking_interview";

  if (stealthMode) {
    return (
      <button
        className="fixed bottom-6 right-6 z-[9999] flex h-12 w-12 items-center justify-center rounded-full border border-slate-700 bg-slate-950 text-white shadow-2xl"
        title="Restore Assistant (Ctrl+Shift+C)"
        onClick={() => setStealthMode(false)}
      >
        <Eye className="h-5 w-5 text-indigo-400" />
      </button>
    );
  }

  return (
    <div className="w-full bg-slate-900 font-sans text-slate-100 selection:bg-indigo-500 selection:text-white">
      <header className="w-full border-b border-slate-800/80 bg-slate-950 px-6 py-3.5">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500"><Bot className="h-5 w-5" /></div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold tracking-tight">AI Meeting Copilot <span className="ml-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase text-emerald-400">Low Latency</span>{activeSessionInfo && <span className={`ml-1 rounded-full border px-2 py-0.5 text-[10px] ${activeSessionInfo?.modeVariant === "course_admission" ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" : "border-indigo-500/20 bg-indigo-500/10 text-indigo-300"}`}>{callPrompt.displayName}</span>}</h1>
              <p className="truncate text-xs text-slate-400">Speaker-aware context · local candidate knowledge · diagnostics on demand</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {activeSessionInfo?.callType === "taking_interview" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const currentVariant = activeSessionInfo?.modeVariant;
                  const newVariant = currentVariant === "course_admission" ? "standard" : "course_admission";
                  sessionManager.updateSessionInfo({ modeVariant: newVariant });
                }}
                className={`h-8 px-3 text-xs border transition-all ${
                  activeSessionInfo?.modeVariant === "course_admission"
                    ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                    : "border-slate-800 text-slate-400 hover:text-white"
                }`}
                title="Toggle Course Selection & Mentoring Mode (Temporary)"
              >
                <GraduationCap className={`mr-1.5 h-3.5 w-3.5 ${activeSessionInfo?.modeVariant === "course_admission" ? "text-emerald-400" : "text-slate-400"}`} />
                {activeSessionInfo?.modeVariant === "course_admission" ? "Course Mode: Active" : "Course Mode: Off"}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setSetupOpen((value) => !value)} className="h-8 px-3 text-xs text-slate-300 hover:text-white border border-slate-800">
              <Database className="mr-1.5 h-3.5 w-3.5 text-violet-400" /> Knowledge & Q&A
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setDiagnosticsOpen(true)} className="relative h-8 px-3 text-xs text-slate-300 hover:text-white border border-slate-800">
              <Activity className="mr-1.5 h-3.5 w-3.5 text-amber-400" /> Diagnostics
              {(metrics || contextSnapshot) && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-emerald-400" />}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPromptOpen(true)} className="h-8 px-3 text-xs text-slate-300 hover:text-white border border-slate-800">
              <Sliders className="mr-1.5 h-3.5 w-3.5 text-indigo-400" /> Prompt
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setStealthMode(true)} className="h-8 px-3 text-xs text-slate-300 hover:text-white border border-slate-800">
              <EyeOff className="mr-1.5 h-3.5 w-3.5 text-indigo-400" /> Stealth
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">
        {setupOpen && (
          <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <KnowledgePackManager />
            <QABankManager />
            <div className="lg:col-span-2"><QAHistoryManager /></div>
            <div className="min-w-0 lg:col-span-2"><LocalDataManager /></div>
          </div>
        )}

        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
          <div className="space-y-5 lg:col-span-5">
            <RecorderTranscriber />
            <div className="h-[500px]"><ChatTranscription messages={chatMessages} onClear={clearVisibleTranscript} callType={activeSessionInfo?.callType} className="h-full" /></div>
          </div>

          <div className="min-w-0 space-y-5 lg:col-span-7">
            <div className="rounded-xl border border-slate-800/80 bg-slate-950/70 p-4 shadow-md">
              <form ref={formRef} onSubmit={handleSubmit} className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/80 px-4 py-2">
                  <Label className="text-xs font-semibold text-slate-400">Summarizer</Label>
                  <Switch className="data-[state=checked]:bg-indigo-600" onCheckedChange={(checked) => setFlag(checked ? FLAGS.COPILOT : FLAGS.SUMMERIZER)} checked={flag === FLAGS.COPILOT} />
                  <Label className="flex items-center gap-1 text-xs font-semibold text-indigo-400"><Sparkles className="h-3.5 w-3.5" /> {activeSessionInfo?.callType === "taking_interview" ? "Follow-up" : activeSessionInfo?.callType === "meeting" ? "Response" : "Answer"}</Label>
                </div>
                <div className="flex gap-2">
                  {isLoading && <Button type="button" variant="ghost" onClick={stop} className="h-10 px-3 text-xs text-slate-400 border border-slate-800">Stop</Button>}
                  <Button type="submit" disabled={isLoading} className="flex h-10 items-center gap-2 rounded-lg bg-indigo-600 px-6 text-xs font-semibold text-white hover:bg-indigo-500">
                    {isLoading ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" /> Streaming…</> : <>{callPrompt.generateActionLabel} <Send className="h-3.5 w-3.5" /></>}
                  </Button>
                </div>
              </form>
              {isLoading && streamStatus && <div className="mt-2 text-right text-[10px] text-slate-500">{streamStatus}</div>}
              {(settingsError || backgroundSetting.error || promptSetting.error) && <div className="mt-2 text-xs text-rose-400">{settingsError || backgroundSetting.error || promptSetting.error}</div>}
            </div>

            {question && flag === FLAGS.COPILOT && (
              <div className="rounded-xl border border-indigo-500/30 bg-indigo-950/40 p-4">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs font-semibold text-indigo-400">
                  <HelpCircle className="h-4 w-4" /> {callPrompt.contextLabel}
                  {showAskConfidence ? (
                    <span className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider ${confidenceStyle}`}>{questionConfidence}</span>
                  ) : (
                    <span className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-cyan-300">follow-up context</span>
                  )}
                  <button type="button" onClick={() => setDiagnosticsOpen(true)} className="ml-auto text-[10px] font-medium text-slate-500 hover:text-indigo-300">View context</button>
                </div>
                <p className="text-sm font-medium italic text-indigo-100">“{question}”</p>
                {showAskConfidence && questionConfidence !== "high" && <p className="mt-1 text-[10px] text-slate-500">{questionConfidence === "medium" ? "Likely reconstructed intent; scenario context is used jointly." : "No reliable explicit ask was found; full scenario context is authoritative."}</p>}
              </div>
            )}

            {isParallel && (slotA.completion || slotB.completion) ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {[slotA, slotB].map((slot, idx) => {
                  const label = idx === 0 ? "A" : "B";
                  const borderColor = idx === 0 ? "border-indigo-500/30" : "border-violet-500/30";
                  const accentBg = idx === 0 ? "bg-indigo-500/10" : "bg-violet-500/10";
                  const accentText = idx === 0 ? "text-indigo-400" : "text-violet-400";
                  const headerBg = idx === 0 ? "bg-indigo-950/30" : "bg-violet-950/30";
                  const isSlotStreaming = isLoading && !slot.done;
                  const hasContent = slot.completion.length > 0;
                  const slotMetrics = slot.metrics;

                  return (
                    <div key={label} className={`overflow-hidden rounded-xl border ${borderColor} bg-slate-950/70 shadow-md`}>
                      <div className={`flex items-center justify-between border-b border-slate-800 ${headerBg} px-4 py-3`}>
                        <div className="flex items-center gap-2">
                          <div className={`flex h-6 w-6 items-center justify-center rounded-md ${accentBg} ${accentText} text-xs font-bold`}>
                            {label}
                          </div>
                          <div>
                            <h3 className="text-sm font-semibold text-slate-200">{slot.provider || "Connecting…"}</h3>
                            {slot.model && <p className="text-[10px] text-slate-500">{slot.model}</p>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {isSlotStreaming && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent text-indigo-400" />}
                          {slot.completed && <span className={`inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400`}><Check className="h-2.5 w-2.5" /> Done</span>}
                          {slot.done && !slot.completed && !slot.error && <span className="text-[10px] text-slate-500">Incomplete</span>}
                          {slot.error && <span className="rounded-full border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-400">Error</span>}
                        </div>
                      </div>
                      {hasContent ? (
                        isSlotStreaming ? (
                          <div className="whitespace-pre-wrap p-4 text-sm leading-relaxed text-slate-200">{slot.completion}</div>
                        ) : (
                          <div className="prose prose-invert max-w-none p-4 text-sm leading-relaxed text-slate-200"><ReactMarkdown>{slot.completion}</ReactMarkdown></div>
                        )
                      ) : slot.error ? (
                        <div className="flex items-center gap-2 p-4 text-xs text-rose-300"><AlertCircle className="h-4 w-4 flex-none" /> {slot.error.message}</div>
                      ) : isSlotStreaming ? (
                        <div className="p-6 text-center">
                          <span className="mx-auto mb-2 block h-5 w-5 animate-spin rounded-full border-2 border-slate-600 border-t-transparent" />
                          <p className="text-xs text-slate-500">Waiting for {slot.provider || "model"}…</p>
                        </div>
                      ) : <div className="p-4 text-xs text-slate-500">No usable output.</div>}
                      {slot.completed && slot.runId && <div className="border-t border-slate-800 px-4 py-2">
                        <Button type="button" variant="ghost" size="sm" onClick={() => selectGeneratedAnswer(slot.runId!)} className="h-7 px-2 text-[10px] text-slate-400">{qaHistoryId === slot.runId ? "Selected for review" : `Review ${label}`}</Button>
                      </div>}
                      {slotMetrics && (
                        <div className="flex flex-wrap gap-3 border-t border-slate-800 bg-slate-900/30 px-4 py-2 text-[10px] text-slate-500">
                          {slotMetrics.serverTtftMs != null && <span>TTFT: {slotMetrics.serverTtftMs}ms</span>}
                          {slotMetrics.totalMs != null && <span>Total: {slotMetrics.totalMs}ms</span>}
                          {slotMetrics.tokensPerSecond != null && <span>{slotMetrics.tokensPerSecond} tok/s</span>}
                          {slotMetrics.outputTokens != null && <span>{slotMetrics.outputTokens} tokens</span>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : completion ? (
              <div className="overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/70 shadow-md">
                <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/50 px-5 py-3.5">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-400">
                      <Zap className="h-3.5 w-3.5" />
                    </div>
                    <h3 className="text-sm font-semibold">{activeSessionInfo?.callType === "taking_interview" ? "Suggested Follow-up" : "Suggested Response"}</h3>
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-400">
                    <Check className="h-3 w-3" /> {primary.completed ? primary.runId ? "Auto-saved" : "Completed" : isLoading ? "Streaming" : "Incomplete"}
                  </span>
                </div>
                {isLoading ? (
                  <div className="whitespace-pre-wrap p-5 text-sm leading-relaxed text-slate-200">{completion}</div>
                ) : (
                  <div className="prose prose-invert max-w-none p-5 text-sm leading-relaxed text-slate-200"><ReactMarkdown>{completion}</ReactMarkdown></div>
                )}
              </div>
            ) : isLoading ? (
              <div className="rounded-xl border border-slate-800/60 bg-slate-950/40 p-10 text-center text-slate-500">
                <span className="mx-auto mb-3 block h-6 w-6 animate-spin rounded-full border-2 border-indigo-400 border-t-transparent" />
                <p className="text-sm font-medium text-slate-400">Preparing answer</p>
                <p className="mt-1 text-xs">Context is ready; waiting for the model to begin streaming.</p>
              </div>
            ) : (
              <div className="rounded-xl border border-slate-800/60 bg-slate-950/40 p-12 text-center text-slate-500">
                <Bot className="mx-auto mb-3 h-10 w-10 text-indigo-400 opacity-30" />
                <p className="text-sm font-medium text-slate-400">Ready</p>
                <p className="mt-1 text-xs">Connect audio, let the {callPrompt.remoteRole} finish, then {callPrompt.generateActionLabel} or press Ctrl+Enter.</p>
              </div>
            )}

            {!isLoading && qaHistoryId && (
              <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 bg-slate-900/30 px-5 py-2.5">
                <span className="mr-1 text-[10px] text-slate-500">Answer quality{isParallel ? ` · ${slotA.runId === qaHistoryId ? "A" : "B"}` : ""}</span>
                <Button type="button" variant="ghost" size="sm" disabled={historyActionBusy || answerPromoted} onClick={() => void rateGeneratedAnswer("good")} className={`h-7 px-2 text-[10px] ${answerFeedback === "good" ? "bg-emerald-500/10 text-emerald-300" : "text-slate-500"}`}><ThumbsUp className="mr-1 h-3 w-3" /> Good</Button>
                <Button type="button" variant="ghost" size="sm" disabled={historyActionBusy || answerPromoted} onClick={() => void rateGeneratedAnswer("poor")} className={`h-7 px-2 text-[10px] ${answerFeedback === "poor" ? "bg-rose-500/10 text-rose-300" : "text-slate-500"}`}><ThumbsDown className="mr-1 h-3 w-3" /> Poor</Button>
                {activeSessionInfo?.callType === "giving_interview" && <Button type="button" variant="ghost" size="sm" disabled={historyActionBusy || answerFeedback !== "good" || answerPromoted} onClick={() => void promoteGeneratedAnswer()} className="h-7 px-2 text-[10px] text-violet-300 disabled:text-slate-700"><BookmarkPlus className="mr-1 h-3 w-3" /> {answerPromoted ? "Promoted" : "Promote to Q&A"}</Button>}
                {historyActionStatus && <span className="text-[10px] text-slate-500">{historyActionStatus}</span>}
              </div>
            )}

            {citations.length > 0 && (
              <div className="space-y-2 rounded-xl border border-slate-800/80 bg-slate-950/70 p-5">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400"><Globe className="h-4 w-4" /> Fresh web sources</div>
                {citations.map((citation, index) => (
                  <a key={`${citation.url}-${index}`} href={citation.url} target="_blank" rel="noreferrer" className="block rounded-lg border border-slate-800 bg-slate-900/70 p-3 hover:border-slate-700">
                    <div className="text-xs font-medium text-slate-200">{citation.title}</div>
                    <div className="mt-0.5 text-[10px] text-emerald-400">{citation.source}</div>
                    <div className="mt-1 line-clamp-2 text-[11px] text-slate-500">{citation.contextSnippet}</div>
                  </a>
                ))}
              </div>
            )}

            {(error || (!isParallel && primary.error)) && <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-950/40 p-4 text-xs text-rose-300"><AlertCircle className="h-4 w-4 flex-none" /> {(error || primary.error)?.message}</div>}
          </div>
        </div>
      </main>

      <PromptModal
        isOpen={promptOpen}
        onClose={() => setPromptOpen(false)}
        bg={bg}
        onSaveBg={saveBackground}
        customRules={customRules}
        onSaveCustomRules={saveRules}
        currentSummary={sessionManager.getSummary()}
        recentTurns={transcriptStateMachine.getRecentFinalizedTurns(12).map((turn) => ({ speaker: turn.speaker, text: turn.text }))}
        focusQuestion={question}
        sessionInfo={activeSessionInfo}
      />

      <DiagnosticsDrawer
        open={diagnosticsOpen}
        onClose={() => setDiagnosticsOpen(false)}
        metrics={metrics}
        context={contextSnapshot}
      />
    </div>
  );
}
