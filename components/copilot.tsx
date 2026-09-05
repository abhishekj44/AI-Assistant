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
import { FLAGS, type HistoryData } from "@/lib/types";
import { transcriptStateMachine, type UtteranceSegment } from "@/lib/transcriptStateMachine";
import { SESSION_INFO_EVENT, sessionManager } from "@/lib/sessionManager";
import { DEFAULT_PROMPT_RULES, LEGACY_PROMPT_RULES_BACKUP_KEY, PREVIOUS_PROMPT_STYLE_STORAGE_KEY, PROMPT_RULES_VERSION, PROMPT_RULES_VERSION_STORAGE_KEY, PROMPT_STYLE_STORAGE_KEY } from "@/lib/utils";
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

function useLiveCompletion(
  body: { bg: string; flag: FLAGS; customRules: string },
  onAutoSave?: (data: HistoryData) => void,
) {
  const [completion, setCompletion] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [question, setQuestion] = useState("");
  const [questionConfidence, setQuestionConfidence] = useState<"high" | "medium" | "fallback">("fallback");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [metrics, setMetrics] = useState<CompletionMetrics | null>(null);
  const [contextSnapshot, setContextSnapshot] = useState<CompletionContextSnapshot | null>(null);
  const [streamStatus, setStreamStatus] = useState("");
  const [qaHistoryId, setQaHistoryId] = useState<string | null>(null);
  const [answerFeedback, setAnswerFeedback] = useState<"good" | "poor" | null>(null);
  const [answerPromoted, setAnswerPromoted] = useState(false);
  const [historyActionStatus, setHistoryActionStatus] = useState("");
  const [historyActionBusy, setHistoryActionBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const handleSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (isLoading) return;

    const questionBundle = transcriptStateMachine.getLatestQuestionBundle();
    const focusQuestion = questionBundle?.primaryAsk
      || transcriptStateMachine.getLatestQuestionContext()
      || transcriptStateMachine.getLatestInterviewerTurn()?.text || "";
    const sessionInfo = sessionManager.getSessionInfo();
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
    setCompletion("");
    setCitations([]);
    setMetrics(null);
    setContextSnapshot(null);
    setError(null);
    setQaHistoryId(null);
    setAnswerFeedback(null);
    setAnswerPromoted(false);
    setHistoryActionStatus("");
    setStreamStatus("Preparing context…");
    setIsLoading(true);

    const requestStarted = performance.now();
    let firstVisibleTokenAt: number | null = null;
    let firstSseAt: number | null = null;
    let pendingText = "";
    let fullGeneratedText = "";
    let streamHadError = false;
    let derivedQuestion = focusQuestion;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    abortRef.current = controller;

    const flushPendingText = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!pendingText) return;
      const next = pendingText;
      pendingText = "";
      setCompletion((previous) => previous + next);
    };

    const enqueueText = (text: string) => {
      pendingText += text;
      fullGeneratedText += text;
      if (flushTimer) return;
      // At most ~25 UI updates/sec. This avoids re-running ReactMarkdown for every provider chunk.
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flushPendingText();
      }, 40);
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
        }),
      });
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
        if (!firstSseAt) {
          firstSseAt = performance.now();
          setMetrics((previous) => ({
            ...(previous || {}),
            clientFirstSseMs: Math.round(firstSseAt! - requestStarted),
          }));
        }

        switch (message.event) {
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
            break;
          case "delta": {
            const text = String(message.data?.text || "");
            if (!text) break;
            if (!firstVisibleTokenAt) {
              firstVisibleTokenAt = performance.now();
              setMetrics((previous) => ({
                ...(previous || {}),
                clientTtftMs: Math.round(firstVisibleTokenAt! - requestStarted),
              }));
            }
            enqueueText(text);
            break;
          }
          case "sources":
            setCitations(Array.isArray(message.data?.citations) ? message.data.citations : []);
            break;
          case "metrics":
            setMetrics((previous) => ({
              ...(previous || {}),
              ...message.data,
              clientTtftMs:
                previous?.clientTtftMs ??
                (firstVisibleTokenAt ? Math.round(firstVisibleTokenAt - requestStarted) : undefined),
            }));
            break;
          case "error":
            streamHadError = true;
            setError(new Error(message.data?.details || message.data?.message || "The model stream was interrupted"));
            break;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
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
      flushPendingText();
      setMetrics((previous) => ({
        ...(previous || {}),
        clientTotalMs: Math.round(performance.now() - requestStarted),
      }));
      setStreamStatus("");

      // Auto-save generated Q&A pair on successful stream completion
      if (!streamHadError && fullGeneratedText.trim()) {
        const finalAnswer = fullGeneratedText.trim();
        const finalQuestion = derivedQuestion || focusQuestion || "";
        const tag = body.flag === FLAGS.SUMMERIZER
          ? "Summarizer"
          : sessionInfo?.callType === "taking_interview"
            ? "Interviewer Follow-up"
            : sessionInfo?.callType === "meeting"
              ? "Meeting Response"
              : "Interview Answer";
        const entry: HistoryData = {
          createdAt: new Date().toISOString(),
          data: finalAnswer,
          tag,
          question: finalQuestion || undefined,
        };
        onAutoSave?.(entry);

        // Persist asynchronously after generation; this is outside the answer critical path.
        void fetch("/api/qa-history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: finalQuestion,
            scenarioContext: questionBundle?.scenarioContext,
            retrievalQuery: questionBundle?.retrievalQuery,
            answer: finalAnswer,
            tag,
            sessionId: sessionManager.getSessionId(),
            callType: sessionInfo?.callType,
          }),
        }).then(async (response) => {
          const payload = await response.json().catch(() => ({}));
          if (response.ok && payload?.id) setQaHistoryId(String(payload.id));
        }).catch((error) => console.warn("Failed to auto-persist Q&A to server", error));
      }
    } catch (caught: any) {
      flushPendingText();
      if (caught?.name !== "AbortError") {
        setError(caught instanceof Error ? caught : new Error("Completion failed"));
      }
    } finally {
      if (flushTimer) clearTimeout(flushTimer);
      abortRef.current = null;
      setStreamStatus("");
      setIsLoading(false);
    }
  }, [body, isLoading, onAutoSave]);

  const rateGeneratedAnswer = useCallback(async (feedback: "good" | "poor") => {
    if (!qaHistoryId || historyActionBusy) return;
    setHistoryActionBusy(true);
    try {
      const response = await fetch("/api/qa-history", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: qaHistoryId, feedback }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Unable to save feedback");
      setAnswerFeedback(feedback);
      setHistoryActionStatus(feedback === "good" ? "Approved for optional Q&A promotion." : "Marked poor; it will remain history only.");
    } catch (caught: any) {
      setHistoryActionStatus(caught?.message || "Unable to save feedback");
    } finally { setHistoryActionBusy(false); }
  }, [qaHistoryId, historyActionBusy]);

  const promoteGeneratedAnswer = useCallback(async () => {
    if (!qaHistoryId || answerFeedback !== "good" || historyActionBusy) return;
    setHistoryActionBusy(true);
    try {
      const response = await fetch("/api/qa-history", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: qaHistoryId }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || "Unable to promote answer");
      setAnswerPromoted(true);
      setHistoryActionStatus(payload?.alreadyExists ? "A matching Prepared Q&A already exists." : "Promoted to Prepared Q&A.");
      window.dispatchEvent(new Event("qa-bank-updated"));
    } catch (caught: any) {
      setHistoryActionStatus(caught?.message || "Unable to promote answer");
    } finally { setHistoryActionBusy(false); }
  }, [qaHistoryId, answerFeedback, historyActionBusy]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStreamStatus("");
    setIsLoading(false);
  }, []);

  return {
    completion,
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
  };
}

export function Copilot({ addInSavedData }: CopilotProps) {
  const [flag, setFlag] = useState<FLAGS>(FLAGS.COPILOT);
  const [bg, setBg] = useState("");
  const [customRules, setCustomRules] = useState(DEFAULT_PROMPT_RULES);
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
    try {
      const savedBg = localStorage.getItem("bg");
      if (savedBg) setBg(savedBg);
      const storedVersion = Number(localStorage.getItem(PROMPT_RULES_VERSION_STORAGE_KEY) || 0);
      if (storedVersion === PROMPT_RULES_VERSION) {
        setCustomRules(localStorage.getItem(PROMPT_STYLE_STORAGE_KEY) || DEFAULT_PROMPT_RULES);
        return;
      }
      const previousStyle = localStorage.getItem(PREVIOUS_PROMPT_STYLE_STORAGE_KEY);
      const legacyRules = localStorage.getItem("custom_prompt_rules");
      const migratedStyle = previousStyle?.trim() || legacyRules?.trim() || DEFAULT_PROMPT_RULES;
      if (legacyRules?.trim()) localStorage.setItem(LEGACY_PROMPT_RULES_BACKUP_KEY, legacyRules.slice(0, 4_000));
      localStorage.setItem(PROMPT_STYLE_STORAGE_KEY, migratedStyle.slice(0, 2_500));
      localStorage.setItem(PROMPT_RULES_VERSION_STORAGE_KEY, String(PROMPT_RULES_VERSION));
      localStorage.removeItem("custom_prompt_rules");
      setCustomRules(migratedStyle.slice(0, 2_500));
    } catch {
      setCustomRules(DEFAULT_PROMPT_RULES);
    }
  }, []);

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
    setBg(value);
    localStorage.setItem("bg", value);
  };
  const saveRules = (value: string) => {
    setCustomRules(value);
    try {
      localStorage.setItem(PROMPT_STYLE_STORAGE_KEY, value);
      localStorage.setItem(PROMPT_RULES_VERSION_STORAGE_KEY, String(PROMPT_RULES_VERSION));
    } catch { /* non-fatal */ }
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
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500"><Bot className="h-5 w-5" /></div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold tracking-tight">AI Meeting Copilot <span className="ml-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase text-emerald-400">Low Latency</span>{activeSessionInfo && <span className="ml-1 rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[10px] text-indigo-300">{callPrompt.displayName}</span>}</h1>
              <p className="truncate text-xs text-slate-400">Speaker-aware context · local candidate knowledge · diagnostics on demand</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
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
          </div>
        )}

        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
          <div className="space-y-5 lg:col-span-5">
            <RecorderTranscriber />
            <div className="h-[500px]"><ChatTranscription messages={chatMessages} onClear={clearVisibleTranscript} className="h-full" /></div>
          </div>

          <div className="space-y-5 lg:col-span-7">
            <div className="rounded-xl border border-slate-800/80 bg-slate-950/70 p-4 shadow-md">
              <form ref={formRef} onSubmit={handleSubmit} className="flex items-center justify-between gap-4">
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

            {completion ? (
              <div className="overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/70 shadow-md">
                <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/50 px-5 py-3.5">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-400">
                      <Zap className="h-3.5 w-3.5" />
                    </div>
                    <h3 className="text-sm font-semibold">{activeSessionInfo?.callType === "taking_interview" ? "Suggested Follow-up" : "Suggested Response"}</h3>
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-400">
                    <Check className="h-3 w-3" /> Auto-saved
                  </span>
                </div>
                {isLoading ? (
                  <div className="whitespace-pre-wrap p-5 text-sm leading-relaxed text-slate-200">{completion}</div>
                ) : (
                  <div className="prose prose-invert max-w-none p-5 text-sm leading-relaxed text-slate-200"><ReactMarkdown>{completion}</ReactMarkdown></div>
                )}
                {!isLoading && qaHistoryId && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 bg-slate-900/30 px-5 py-2.5">
                    <span className="mr-1 text-[10px] text-slate-500">Answer quality</span>
                    <Button type="button" variant="ghost" size="sm" disabled={historyActionBusy || answerPromoted} onClick={() => void rateGeneratedAnswer("good")} className={`h-7 px-2 text-[10px] ${answerFeedback === "good" ? "bg-emerald-500/10 text-emerald-300" : "text-slate-500"}`}><ThumbsUp className="mr-1 h-3 w-3" /> Good</Button>
                    <Button type="button" variant="ghost" size="sm" disabled={historyActionBusy || answerPromoted} onClick={() => void rateGeneratedAnswer("poor")} className={`h-7 px-2 text-[10px] ${answerFeedback === "poor" ? "bg-rose-500/10 text-rose-300" : "text-slate-500"}`}><ThumbsDown className="mr-1 h-3 w-3" /> Poor</Button>
                    {activeSessionInfo?.callType === "giving_interview" && <Button type="button" variant="ghost" size="sm" disabled={historyActionBusy || answerFeedback !== "good" || answerPromoted} onClick={() => void promoteGeneratedAnswer()} className="h-7 px-2 text-[10px] text-violet-300 disabled:text-slate-700"><BookmarkPlus className="mr-1 h-3 w-3" /> {answerPromoted ? "Promoted" : "Promote to Q&A"}</Button>}
                    {historyActionStatus && <span className="text-[10px] text-slate-500">{historyActionStatus}</span>}
                  </div>
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

            {error && <div className="flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-950/40 p-4 text-xs text-rose-300"><AlertCircle className="h-4 w-4 flex-none" /> {error.message}</div>}
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
