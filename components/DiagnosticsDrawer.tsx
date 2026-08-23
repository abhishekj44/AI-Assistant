"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Braces,
  Clipboard,
  Database,
  Gauge,
  MessageSquareText,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CompletionContextSnapshot, CompletionMetrics } from "@/lib/diagnostics/types";

interface DiagnosticsDrawerProps {
  open: boolean;
  onClose: () => void;
  metrics: CompletionMetrics | null;
  context: CompletionContextSnapshot | null;
}

type Tab = "context" | "qna" | "metrics" | "prompt";

function formatMs(value?: number | null): string {
  return value == null ? "—" : `${Math.round(value)} ms`;
}

function diagnoseLatency(metrics: CompletionMetrics): { label: string; detail: string } {
  const ttft = metrics.clientTtftMs ?? metrics.serverTtftMs ?? 0;
  const modelWait = metrics.modelWaitMs ?? 0;
  const preModel = metrics.preModelMs ?? 0;
  const web = metrics.webMs ?? 0;

  if (ttft > 0 && modelWait >= Math.max(1_000, ttft * 0.55)) {
    return {
      label: "Model queue / prefill",
      detail: `${formatMs(modelWait)} of the wait is inside model startup + first-chunk processing.`,
    };
  }
  if (ttft > 0 && preModel >= Math.max(750, ttft * 0.4)) {
    return {
      label: "Application pre-model path",
      detail: `${formatMs(preModel)} is spent before the model request starts.`,
    };
  }
  if (web >= 500) return { label: "Fresh-web lookup", detail: `${formatMs(web)} is spent on web lookup.` };
  if (ttft > 2_000) return { label: "Mixed / needs more samples", detail: "No single measured phase dominates." };
  return { label: "Healthy", detail: "No major latency bottleneck is visible in this request." };
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 truncate text-xs font-semibold text-slate-200" title={value}>{value}</div>
    </div>
  );
}

function CodeBlock({ value, empty = "No data was passed." }: { value?: string; empty?: string }) {
  const [copied, setCopied] = useState(false);
  const text = value?.trim() || "";

  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  if (!text) return <div className="text-xs text-slate-500">{empty}</div>;

  return (
    <div className="relative rounded-lg border border-slate-800 bg-slate-950/80">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void copy()}
        className="absolute right-2 top-2 z-10 h-7 px-2 text-[10px] text-slate-400"
      >
        <Clipboard className="mr-1 h-3 w-3" /> {copied ? "Copied" : "Copy"}
      </Button>
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words p-3 pr-20 text-[11px] leading-relaxed text-slate-300">
        {text}
      </pre>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{title}</div>
      {children}
    </section>
  );
}

function ContextTab({ context }: { context: CompletionContextSnapshot | null }) {
  if (!context) return <div className="text-sm text-slate-500">Generate an answer to capture the exact context sent to the model.</div>;

  const candidateSummary = `${context.candidate.selectedChars.toLocaleString()} selected / ${context.candidate.rawChars.toLocaleString()} raw chars · budget ${context.candidate.budgetChars.toLocaleString()}`;

  return (
    <div className="space-y-5">
      <Section title="Current question">
        <div className="rounded-lg border border-indigo-500/20 bg-indigo-950/30 p-3 text-sm text-indigo-100">{context.question}</div>
      </Section>

      <Section title="Candidate knowledge actually passed">
        <div className="mb-2 text-[11px] text-slate-500">
          {candidateSummary}
          {context.candidate.compressionRatio != null ? ` · ${(context.candidate.compressionRatio * 100).toFixed(1)}% of raw pack` : ""}
        </div>
        <div className="mb-2 flex flex-wrap gap-1.5 text-[10px]">
          <span className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2 py-1 text-cyan-300">answer: {context.answerProfile.mode} · {context.answerProfile.minWords}-{context.answerProfile.maxWords} words</span>
          {context.candidate.topProjectName && <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-emerald-300">protected project: {context.candidate.topProjectName} · score {context.candidate.topProjectScore ?? "—"}</span>}
          {context.candidate.projectExampleIncluded && <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-amber-300">project example included</span>}
        </div>
        {context.candidate.selectedExampleTitles.length > 0 && (
          <div className="mb-2 text-[11px] text-slate-500">Selected example: <span className="text-slate-300">{context.candidate.selectedExampleTitles.join(" · ")}</span></div>
        )}
        {(context.candidate.selectedProjects.length > 0 || context.candidate.selectedExperience.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-1.5 text-[10px]">
            {context.candidate.selectedProjects.map((name) => <span key={`project-${name}`} className="rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2 py-1 text-indigo-300">project: {name}</span>)}
            {context.candidate.selectedExperience.map((name) => <span key={`experience-${name}`} className="rounded-full border border-slate-700 bg-slate-900 px-2 py-1 text-slate-400">experience: {name}</span>)}
          </div>
        )}
        <CodeBlock value={context.candidate.selectedContext} />
      </Section>

      <Section title="Recent conversation actually passed">
        <CodeBlock value={context.recentConversationText} empty="No recent conversation was included." />
      </Section>

      <Section title="Meeting memory actually passed">
        <CodeBlock value={context.meetingMemoryText} empty="No meeting memory was included." />
      </Section>

      <Section title="Candidate notes / persona context">
        <CodeBlock value={context.candidateNotes} empty="No candidate notes were included." />
      </Section>

      <Section title="Fresh web context actually passed">
        <CodeBlock value={context.webContextText} empty="No web lookup was used." />
      </Section>
    </div>
  );
}

function QnaTab({ context }: { context: CompletionContextSnapshot | null }) {
  if (!context) return <div className="text-sm text-slate-500">Generate an answer to see Q&A matches.</div>;
  if (context.qna.matches.length === 0) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-500">
        No prepared Q&A matched this question. Bank entries: {context.qna.bankEntries}.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-slate-400">
        {context.qna.matches.length} match{context.qna.matches.length === 1 ? "" : "es"} from {context.qna.bankEntries} entries
        {context.qna.strongMatch ? " · strong match reduced the candidate-context budget" : ""}.
      </div>
      {context.qna.matches.map((match) => (
        <div key={match.id} className="rounded-xl border border-violet-500/20 bg-violet-950/20 p-4 space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="text-xs font-semibold text-violet-200">{match.primaryQuestion}</div>
              <div className="mt-1 text-[10px] text-slate-500">matched: {match.matchedQuestion || "content/tags"} · {match.category || "general"}</div>
            </div>
            <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-1 text-[10px] text-violet-300">score {match.score}</span>
          </div>
          <div className="text-xs leading-relaxed text-slate-300">{match.preparedAnswer}</div>
          {match.keyPoints.length > 0 && (
            <ul className="list-disc space-y-1 pl-4 text-[11px] text-slate-400">
              {match.keyPoints.map((point) => <li key={point}>{point}</li>)}
            </ul>
          )}
        </div>
      ))}
      <Section title="Exact Q&A guidance passed to the model">
        <CodeBlock value={context.qna.guidance} />
      </Section>
    </div>
  );
}

function MetricsTab({ metrics }: { metrics: CompletionMetrics | null }) {
  if (!metrics) return <div className="text-sm text-slate-500">No completion metrics are available yet.</div>;
  const diagnosis = diagnoseLatency(metrics);
  const cacheValue = metrics.cachedInputTokens != null
    ? `${metrics.cachedInputTokens}${metrics.cacheHitPercent != null ? ` (${metrics.cacheHitPercent}%)` : ""}`
    : "—";

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-amber-500/20 bg-amber-950/20 p-4">
        <div className="text-[10px] uppercase tracking-wider text-slate-500">Likely bottleneck</div>
        <div className="mt-1 text-sm font-semibold text-amber-300">{diagnosis.label}</div>
        <div className="mt-1 text-[11px] text-slate-400">{diagnosis.detail}</div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Metric label="TTFT" value={formatMs(metrics.clientTtftMs)} />
        <Metric label="Throughput" value={metrics.tokensPerSecond != null ? `${metrics.tokensPerSecond} tok/s` : "—"} />
        <Metric label="Total" value={formatMs(metrics.clientTotalMs ?? metrics.totalMs)} />
        <Metric label="Model" value={metrics.model ? `${metrics.provider}/${metrics.model}` : "—"} />
        <Metric label="HTTP headers" value={formatMs(metrics.clientResponseHeadersMs)} />
        <Metric label="First SSE" value={formatMs(metrics.clientFirstSseMs)} />
        <Metric label="Server pre-model" value={formatMs(metrics.preModelMs)} />
        <Metric label="Model connect" value={formatMs(metrics.modelConnectMs)} />
        <Metric label="First chunk wait" value={formatMs(metrics.firstChunkDelayMs)} />
        <Metric label="Model wait" value={formatMs(metrics.modelWaitMs)} />
        <Metric label="Server TTFT" value={formatMs(metrics.serverTtftMs)} />
        <Metric label="Generation" value={formatMs(metrics.generationMs)} />
        <Metric label="Input tokens" value={metrics.inputTokens?.toLocaleString() || "—"} />
        <Metric label="Cached input" value={cacheValue} />
        <Metric label="Output tokens" value={metrics.outputTokens?.toLocaleString() || "—"} />
        <Metric label="Prompt chars" value={metrics.promptChars?.toLocaleString() || "—"} />
        <Metric label="Candidate raw" value={metrics.candidateRawChars?.toLocaleString() || "—"} />
        <Metric label="Candidate selected" value={metrics.candidateContextChars?.toLocaleString() || "—"} />
        <Metric label="Candidate budget" value={metrics.candidateBudgetChars?.toLocaleString() || "—"} />
        <Metric label="Compression" value={metrics.candidateCompressionRatio != null ? `${(metrics.candidateCompressionRatio * 100).toFixed(1)}%` : "—"} />
        <Metric label="Top project" value={metrics.topProjectName ? `${metrics.topProjectName}${metrics.topProjectScore != null ? ` (${metrics.topProjectScore})` : ""}` : "—"} />
        <Metric label="Project example" value={metrics.projectExampleIncluded ? "included" : metrics.projectEvidenceRequired ? "no example available" : "not required"} />
        <Metric label="Answer mode" value={metrics.answerMode ? `${metrics.answerMode}${metrics.answerTargetWords ? ` · ${metrics.answerTargetWords} words` : ""}` : "—"} />
        <Metric label="Recent context" value={metrics.recentContextChars?.toLocaleString() || "—"} />
        <Metric label="Q&A matches" value={metrics.qaMatches != null ? `${metrics.qaMatches}/${metrics.qaBankEntries ?? 0}` : "—"} />
        <Metric label="Q&A select" value={formatMs(metrics.qaSelectionMs)} />
        <Metric label="Web" value={formatMs(metrics.webMs)} />
      </div>

      <div className="text-[10px] text-slate-500">
        tier: <span className="text-slate-300">{metrics.serviceTierActual || metrics.serviceTierRequested || "standard"}</span>
        {" · "}thinking: <span className="text-slate-300">{metrics.thinkingLevel || "—"}</span>
        {" · "}attempts: <span className="text-slate-300">{metrics.attemptCount ?? "—"}</span>
      </div>
      {metrics.attemptedTargets?.length ? (
        <div className="break-all text-[10px] text-slate-500">provider path: <span className="text-slate-400">{metrics.attemptedTargets.join(" → ")}</span></div>
      ) : null}
    </div>
  );
}

function PromptTab({ context }: { context: CompletionContextSnapshot | null }) {
  if (!context) return <div className="text-sm text-slate-500">Generate an answer to inspect the exact prompt.</div>;
  return (
    <div className="space-y-5">
      <Section title={`System instruction · ${context.systemInstructionChars.toLocaleString()} chars`}>
        <CodeBlock value={context.systemInstruction} />
      </Section>
      <Section title={`Exact user prompt · ${context.promptChars.toLocaleString()} chars`}>
        <CodeBlock value={context.prompt} />
      </Section>
    </div>
  );
}

export function DiagnosticsDrawer({ open, onClose, metrics, context }: DiagnosticsDrawerProps) {
  const [tab, setTab] = useState<Tab>("context");
  const tabs = useMemo(
    () => [
      { id: "context" as const, label: "Context", icon: Database },
      { id: "qna" as const, label: "Q&A", icon: MessageSquareText },
      { id: "metrics" as const, label: "Metrics", icon: Gauge },
      { id: "prompt" as const, label: "Exact Prompt", icon: Braces },
    ],
    [],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9998] flex justify-end bg-black/60 backdrop-blur-[1px]" onMouseDown={onClose}>
      <aside
        className="h-full w-full max-w-3xl overflow-hidden border-l border-slate-800 bg-slate-900 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950 px-4 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-400"><Activity className="h-4 w-4" /></div>
              <div>
                <div className="text-sm font-semibold text-slate-100">Request Diagnostics</div>
                <div className="text-[10px] text-slate-500">Exact context, Q&A selection and latency are kept off the live meeting screen.</div>
              </div>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0 text-slate-400"><X className="h-4 w-4" /></Button>
          </div>

          <div className="flex gap-1 overflow-x-auto border-b border-slate-800 bg-slate-950/70 px-3 py-2">
            {tabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors ${tab === id ? "bg-indigo-500/15 text-indigo-300" : "text-slate-500 hover:bg-slate-900 hover:text-slate-300"}`}
              >
                <Icon className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-4">
            {tab === "context" && <ContextTab context={context} />}
            {tab === "qna" && <QnaTab context={context} />}
            {tab === "metrics" && <MetricsTab metrics={metrics} />}
            {tab === "prompt" && <PromptTab context={context} />}
          </div>

          {(metrics || context) && (
            <div className="border-t border-slate-800 bg-slate-950 px-4 py-2 text-[10px] text-slate-500">
              {context?.requestId ? `request ${context.requestId}` : "request diagnostics"}
              {metrics?.clientTtftMs != null ? ` · TTFT ${metrics.clientTtftMs} ms` : ""}
              {metrics?.tokensPerSecond != null ? ` · ${metrics.tokensPerSecond} tok/s` : ""}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
