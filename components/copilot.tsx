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
  Save,
  Send,
  Sliders,
  Sparkles,
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
import { sessionManager } from "@/lib/sessionManager";
import { DEFAULT_PROMPT_RULES } from "@/lib/utils";
import type { CompletionContextSnapshot, CompletionMetrics } from "@/lib/diagnostics/types";

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

function useLiveCompletion(body: { bg: string; flag: FLAGS; customRules: string }) {
  const [completion, setCompletion] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [question, setQuestion] = useState("");
  const [citations, setCitations] = useState<Citation[]>([]);
  const [metrics, setMetrics] = useState<CompletionMetrics | null>(null);
  const [contextSnapshot, setContextSnapshot] = useState<CompletionContextSnapshot | null>(null);
  const [streamStatus, setStreamStatus] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const handleSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (isLoading) return;

    const focusQuestion = transcriptStateMachine.getLatestQuestionContext(3, 2, 3_500);
    const recentTurns = transcriptStateMachine.getRecentFinalizedTurns(14);
    if (body.flag === FLAGS.COPILOT && !focusQuestion) {
      setError(new Error("No finalized interviewer question is available yet."));
      return;
    }

    setQuestion(focusQuestion);
    setCompletion("");
    setCitations([]);
    setMetrics(null);
    setContextSnapshot(null);
    setError(null);
    setStreamStatus("Preparing context…");
    setIsLoading(true);

    const requestStarted = performance.now();
    let firstVisibleTokenAt: number | null = null;
    let firstSseAt: number | null = null;
    let pendingText = "";
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
          recentTurns,
          memory: sessionManager.getMemory(),
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
          case "context":
            setContextSnapshot(message.data as CompletionContextSnapshot);
            break;
          case "status":
            if (message.data?.message) setStreamStatus(String(message.data.message));
            break;
          case "meta":
            if (message.data?.question) setQuestion(message.data.question);
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
  }, [body, isLoading]);

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
    citations,
    metrics,
    contextSnapshot,
    streamStatus,
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
  const [isSaved, setIsSaved] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const requestBody = { bg, flag, customRules };
  const {
    completion,
    isLoading,
    error,
    question,
    citations,
    metrics,
    contextSnapshot,
    streamStatus,
    handleSubmit,
    stop,
  } = useLiveCompletion(requestBody);

  useEffect(() => {
    const savedBg = localStorage.getItem("bg");
    const savedRules = localStorage.getItem("custom_prompt_rules");
    if (savedBg) setBg(savedBg);
    if (savedRules) setCustomRules(savedRules);
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

  const saveAnswer = () => {
    if (!completion) return;
    addInSavedData({
      createdAt: new Date().toISOString(),
      data: completion,
      tag: flag === FLAGS.COPILOT ? "AI Mode" : "Summarizer",
    });
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2_000);
  };

  const saveBackground = (value: string) => {
    setBg(value);
    localStorage.setItem("bg", value);
  };
  const saveRules = (value: string) => {
    setCustomRules(value);
    localStorage.setItem("custom_prompt_rules", value);
  };

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
              <h1 className="truncate text-base font-bold tracking-tight">AI Meeting Copilot <span className="ml-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] uppercase text-emerald-400">Low Latency</span></h1>
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
                  <Label className="flex items-center gap-1 text-xs font-semibold text-indigo-400"><Sparkles className="h-3.5 w-3.5" /> Answer</Label>
                </div>
                <div className="flex gap-2">
                  {isLoading && <Button type="button" variant="ghost" onClick={stop} className="h-10 px-3 text-xs text-slate-400 border border-slate-800">Stop</Button>}
                  <Button type="submit" disabled={isLoading} className="flex h-10 items-center gap-2 rounded-lg bg-indigo-600 px-6 text-xs font-semibold text-white hover:bg-indigo-500">
                    {isLoading ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" /> Streaming…</> : <>Generate Answer <Send className="h-3.5 w-3.5" /></>}
                  </Button>
                </div>
              </form>
              {isLoading && streamStatus && <div className="mt-2 text-right text-[10px] text-slate-500">{streamStatus}</div>}
            </div>

            {question && flag === FLAGS.COPILOT && (
              <div className="rounded-xl border border-indigo-500/30 bg-indigo-950/40 p-4">
                <div className="mb-1 flex items-center gap-2 text-xs font-semibold text-indigo-400"><HelpCircle className="h-4 w-4" /> Current interviewer question</div>
                <p className="text-sm font-medium italic text-indigo-100">“{question}”</p>
              </div>
            )}

            {completion ? (
              <div className="overflow-hidden rounded-xl border border-slate-800/80 bg-slate-950/70 shadow-md">
                <div className="flex items-center justify-between border-b border-slate-800 bg-slate-900/50 px-5 py-3.5">
                  <div className="flex items-center gap-2"><div className="flex h-6 w-6 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-400"><Zap className="h-3.5 w-3.5" /></div><h3 className="text-sm font-semibold">Suggested Response</h3></div>
                  <Button onClick={saveAnswer} variant="ghost" size="sm" className="h-8 px-3 text-xs text-indigo-400">
                    {isSaved ? <><Check className="mr-1 h-3.5 w-3.5 text-emerald-400" /> Saved</> : <><Save className="mr-1 h-3.5 w-3.5" /> Save</>}
                  </Button>
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
                <p className="mt-1 text-xs">Connect audio, let the interviewer finish, then Generate Answer or press Ctrl+Enter.</p>
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
