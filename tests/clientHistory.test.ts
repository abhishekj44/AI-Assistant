import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { FLAGS, isCompletedOutput, legacyHistoryId, mapSavedHistory, migrateSavedHistory, type HistoryData } from "../lib/types";

test("saved database history retains identity, time, tag and content", () => {
  assert.deepEqual(mapSavedHistory({ id: "run-b", createdAt: "2026-10-06T12:00:00Z", answer: "Answer", question: "Question", tag: "Meeting Response", status: "COMPLETED" }), {
    id: "run-b", createdAt: "2026-10-06T12:00:00Z", data: "Answer", question: "Question", tag: "Meeting Response",
  });
});

test("only usable completed slots qualify, with legacy done compatibility", () => {
  assert.equal(isCompletedOutput("Answer B", true, false, { status: "COMPLETED", completed: true }), true);
  assert.equal(isCompletedOutput("Legacy", true, false), true);
  assert.equal(isCompletedOutput("Partial A", false, false), false);
  assert.equal(isCompletedOutput("Partial A", true, false, { completed: false }), false);
  assert.equal(isCompletedOutput("Partial A", true, false, { status: "INTERRUPTED" }), false);
  assert.equal(isCompletedOutput("Error", true, true, { status: "COMPLETED" }), false);
  assert.equal(isCompletedOutput("   ", true, false, { status: "COMPLETED" }), false);
});

test("legacy migration ids are repeatable and distinguish timestamp collisions", () => {
  const entry = { createdAt: "2026-10-06T12:00:00Z", data: "Answer", tag: "Interview Answer" };
  assert.equal(legacyHistoryId(entry, 0), legacyHistoryId({ ...entry }, 0));
  assert.notEqual(legacyHistoryId(entry, 0), legacyHistoryId(entry, 1));
  assert.notEqual(legacyHistoryId(entry, 0), legacyHistoryId({ ...entry, data: "Other" }, 0));
  assert.equal(legacyHistoryId({ ...entry, id: "existing-id" }, 0), "existing-id");
});

test("migration retains source until every import is acknowledged and retries stable ids", async () => {
  const entries = [{ createdAt: "2026-10-06T12:00:00Z", data: "First", tag: "Interview Answer" }, { createdAt: "2026-10-06T12:00:00Z", data: "Second", tag: "Summarizer" }];
  let raw: string | null = JSON.stringify(entries);
  const storage = { getItem: () => raw, removeItem: () => { raw = null; } };
  const imported: string[] = [];
  await assert.rejects(migrateSavedHistory(storage, async (entry) => { imported.push(entry.id); if (entry.data === "Second") throw new Error("Offline"); }));
  assert.equal(raw, JSON.stringify(entries));
  await migrateSavedHistory(storage, async (entry) => { assert.equal(entry.id, imported[entries.findIndex((original) => original.data === entry.data)]); });
  assert.equal(raw, null);
});

test("invalid or concurrently changed migration source is never removed", async () => {
  let raw: string | null = "invalid";
  const storage = { getItem: () => raw, removeItem: () => { raw = null; } };
  await assert.rejects(migrateSavedHistory(storage, async () => {}));
  assert.equal(raw, "invalid");
  raw = JSON.stringify([{ createdAt: "time", data: "Answer", tag: "Tag" }]);
  await migrateSavedHistory(storage, async () => { raw = "changed"; });
  assert.equal(raw, "changed");
});

type StreamEvent = [string, Record<string, unknown>];
function streamResponse(events: StreamEvent[]): Response {
  return new Response(new ReadableStream({ start(controller) {
    for (const [event, data] of events) controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    controller.close();
  } }));
}

interface CompletionView {
  completion: string;
  isParallel: boolean;
  isLoading: boolean;
  qaHistoryId: string | null;
  answerFeedback: string | null;
  answerPromoted: boolean;
  historyActionStatus: string;
  historyActionBusy: boolean;
  metrics: { clientTtftMs?: number } | null;
  slotA: { completed: boolean; metrics: { clientTtftMs?: number } | null };
  slotB: { completed: boolean; metrics: { clientTtftMs?: number } | null };
  handleSubmit: (event: { preventDefault: () => void }) => Promise<void>;
  rateGeneratedAnswer: (feedback: "good" | "poor") => Promise<void>;
  promoteGeneratedAnswer: () => Promise<void>;
  selectGeneratedAnswer: (id: string) => void;
  stop: () => void;
}

function completionHarness(fetcher: typeof fetch) {
  const state: unknown[] = [];
  const cleanups: Array<() => void> = [];
  let cursor = 0;
  const saved: HistoryData[] = [];
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (next: unknown) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!(index in state)) state[index] = { current: initial };
      return state[index];
    },
    useCallback(callback: unknown) { return callback; },
    useEffect(effect: () => (() => void), dependencies: unknown[]) {
      const index = cursor++;
      if (!(index in state)) { state[index] = dependencies; cleanups.push(effect()); }
    },
  };
  const source = readFileSync("components/copilot.tsx", "utf8");
  const compiled = ts.transpileModule(`${source}\nexport { useLiveCompletion };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports: { useLiveCompletion?: (body: unknown, save: (entry: HistoryData) => void) => CompletionView } = {};
  runInNewContext(compiled, {
    exports, fetch: fetcher, AbortController, TextDecoder, performance, setTimeout, clearTimeout, Error, console, Event,
    window: { dispatchEvent() {} },
    require(name: string) {
      if (name === "react") return react;
      if (name === "next/dynamic") return () => () => null;
      if (name === "@/lib/types") return { FLAGS, isCompletedOutput };
      if (name === "@/lib/transcriptStateMachine") return { transcriptStateMachine: {
        getLatestQuestionBundle: () => ({ primaryAsk: "Question?", primaryAskConfidence: "high" }),
        getRecentFinalizedTurns: () => [],
      } };
      if (name === "@/lib/sessionManager") return { sessionManager: {
        getSessionInfo: () => ({ callType: "giving_interview" }), getMemory: () => ({}), getSessionId: () => "session-id",
        getOwnerTabId: () => "owner-tab", getStartedAt: () => "2026-10-06T12:00:00.000Z",
        getPendingTurns: () => [],
      } };
      return {};
    },
  });
  const render = () => {
    cursor = 0;
    return exports.useLiveCompletion!({ bg: "", flag: FLAGS.COPILOT, customRules: "" }, (entry) => saved.push(entry));
  };
  return { render, saved, unmount: () => cleanups.forEach((cleanup) => cleanup?.()) };
}

test("B-only SSE uses one live view, preserves real-text TTFT and never POSTs a text copy", async () => {
  const requests: string[] = [];
  const harness = completionHarness(async (url) => {
    requests.push(String(url));
    return streamResponse([
      ["parallel_init", { slots: [{ slot: "B", provider: "Provider B", model: "Model B" }] }],
      ["meta_b", { runId: "run-b", requestId: "request-b", provider: "Provider B", model: "Model B" }],
      ["delta_b", { text: "  " }], ["delta_b", { text: "Answer B" }],
      ["metrics_b", { totalMs: 50, clientTtftMs: 999999 }],
      ["done_b", { runId: "run-b", status: "COMPLETED", completed: true }],
    ]);
  });
  await harness.render().handleSubmit({ preventDefault() {} });
  const view = harness.render();
  assert.equal(view.isParallel, false);
  assert.equal(view.completion, "  Answer B");
  assert.equal(view.qaHistoryId, "run-b");
  assert.equal(harness.saved.length, 1);
  assert.equal(harness.saved[0].id, "run-b");
  assert.equal(harness.saved[0].data, "Answer B");
  assert.equal(typeof view.slotB.metrics?.clientTtftMs, "number");
  assert.notEqual(view.slotB.metrics?.clientTtftMs, 999999);
  assert.equal(view.metrics?.clientTtftMs, view.slotB.metrics?.clientTtftMs);
  assert.deepEqual(requests, ["/api/completion"]);
  harness.unmount();
});

test("interrupted A is never saved while completed B can be rated and promoted", async () => {
  const actions: Array<{ method?: string; body: Record<string, unknown> }> = [];
  const harness = completionHarness(async (url, options) => {
    if (String(url) !== "/api/completion") {
      actions.push({ method: options?.method, body: JSON.parse(String(options?.body)) });
      return Response.json({ id: "run-b" });
    }
    return streamResponse([
      ["parallel_init", { slots: [{ slot: "A" }, { slot: "B" }] }],
      ["meta_a", { runId: "run-a" }], ["meta_b", { runId: "run-b" }],
      ["delta_a", { text: "Partial A" }], ["delta_b", { text: "Answer B" }],
      ["done_a", { runId: "run-a", status: "INTERRUPTED", completed: false }],
      ["done_b", { runId: "run-b", status: "COMPLETED", completed: true }],
    ]);
  });
  await harness.render().handleSubmit({ preventDefault() {} });
  assert.equal(harness.render().isParallel, true);
  assert.equal(harness.render().slotA.completed, false);
  assert.deepEqual(harness.saved.map((entry) => entry.id), ["run-b"]);
  harness.render().selectGeneratedAnswer("run-a");
  assert.equal(harness.render().qaHistoryId, "run-b");
  await harness.render().rateGeneratedAnswer("good");
  await harness.render().promoteGeneratedAnswer();
  assert.equal(harness.render().answerPromoted, true);
  assert.deepEqual(actions, [{ method: "PATCH", body: { id: "run-b", feedback: "good" } }, { method: "PUT", body: { id: "run-b" } }]);
  harness.unmount();
});

test("single-slot delta_a and legacy delta/done remain compatible", async () => {
  for (const legacy of [false, true]) {
    const suffix = legacy ? "" : "_a";
    const harness = completionHarness(async () => streamResponse([
      ...(legacy ? [] : [["parallel_init", { slots: [{ slot: "A" }] }] as StreamEvent]),
      [`meta${suffix}`, { runId: "run-a" }], [`delta${suffix}`, { text: "Answer A" }], [`done${suffix}`, {}],
    ]));
    await harness.render().handleSubmit({ preventDefault() {} });
    assert.equal(harness.render().isParallel, false);
    assert.equal(harness.render().completion, "Answer A");
    assert.equal(harness.saved[0].id, "run-a");
    harness.unmount();
  }
});

test("an old fetch finally cannot clear a newer loading request after stop", async () => {
  let resolveOld!: (response: Response) => void;
  let resolveNew!: (response: Response) => void;
  let requestCount = 0;
  const harness = completionHarness(() => {
    requestCount += 1;
    return new Promise<Response>((resolve) => { if (requestCount === 1) resolveOld = resolve; else resolveNew = resolve; });
  });
  const oldRequest = harness.render().handleSubmit({ preventDefault() {} });
  harness.render().stop();
  const newRequest = harness.render().handleSubmit({ preventDefault() {} });
  resolveOld(streamResponse([["delta", { text: "Old answer" }], ["done", { runId: "old-run", completed: true, status: "COMPLETED" }]]));
  await oldRequest;
  assert.equal(harness.render().isLoading, true);
  assert.equal(harness.render().completion, "");
  assert.equal(harness.saved.length, 0);
  resolveNew(streamResponse([["meta", { runId: "new-run" }], ["delta", { text: "New answer" }], ["done", { completed: true, status: "COMPLETED" }]]));
  await newRequest;
  assert.equal(harness.render().completion, "New answer");
  assert.deepEqual(harness.saved.map((entry) => entry.id), ["new-run"]);
  harness.unmount();
});

test("late feedback cannot overwrite the next run and unmount aborts its fetch", async () => {
  let resolveFeedback!: (response: Response) => void;
  let completionCount = 0;
  let latestSignal: AbortSignal | null | undefined;
  const harness = completionHarness((url, options) => {
    if (String(url) === "/api/qa-history") return new Promise<Response>((resolve) => { resolveFeedback = resolve; });
    completionCount += 1;
    latestSignal = options?.signal;
    return Promise.resolve(streamResponse([["meta", { runId: `run-${completionCount}` }], ["delta", { text: "Answer" }], ["done", { completed: true, status: "COMPLETED" }]]));
  });
  await harness.render().handleSubmit({ preventDefault() {} });
  const feedback = harness.render().rateGeneratedAnswer("good");
  await harness.render().handleSubmit({ preventDefault() {} });
  resolveFeedback(Response.json({ id: "run-1" }));
  await feedback;
  assert.equal(harness.render().qaHistoryId, "run-2");
  assert.equal(harness.render().answerFeedback, null);
  assert.equal(harness.render().historyActionStatus, "");
  assert.equal(harness.render().historyActionBusy, false);
  harness.unmount();
  assert.equal(latestSignal?.aborted, true);
});

test("selected comparison review targets the right run and switching aborts stale feedback", async () => {
  let resolveFeedback!: (response: Response) => void;
  let feedbackSignal: AbortSignal | null | undefined;
  const targets: string[] = [];
  const harness = completionHarness((url, options) => {
    if (String(url) === "/api/qa-history") {
      targets.push(JSON.parse(String(options?.body)).id);
      feedbackSignal = options?.signal;
      return new Promise<Response>((resolve) => { resolveFeedback = resolve; });
    }
    return Promise.resolve(streamResponse([
      ["parallel_init", { slots: [{ slot: "A" }, { slot: "B" }] }],
      ["meta_a", { runId: "run-a" }], ["meta_b", { runId: "run-b" }],
      ["delta_a", { text: "Answer A" }], ["delta_b", { text: "Answer B" }],
      ["done_a", { status: "COMPLETED", completed: true }], ["done_b", { status: "COMPLETED", completed: true }],
    ]));
  });
  await harness.render().handleSubmit({ preventDefault() {} });
  assert.deepEqual(harness.saved.map((entry) => entry.id), ["run-a", "run-b"]);
  harness.render().selectGeneratedAnswer("run-b");
  const feedback = harness.render().rateGeneratedAnswer("good");
  harness.render().selectGeneratedAnswer("run-a");
  assert.equal(feedbackSignal?.aborted, true);
  resolveFeedback(Response.json({ id: "run-b" }));
  await feedback;
  assert.deepEqual(targets, ["run-b"]);
  assert.equal(harness.render().answerFeedback, null);
  assert.equal(harness.render().historyActionBusy, false);
  harness.render().stop();
  const afterStop = harness.render().rateGeneratedAnswer("good");
  harness.unmount();
  assert.equal(feedbackSignal?.aborted, true);
  resolveFeedback(Response.json({ id: "run-a" }));
  await afterStop;
  assert.equal(harness.render().answerFeedback, null);
});

test("EOF without done and completed empty output never auto-save", async () => {
  for (const events of [
    [["meta", { runId: "partial-run" }], ["delta", { text: "Partial" }]],
    [["meta", { runId: "empty-run" }], ["delta", { text: "   " }], ["done", { status: "COMPLETED", completed: true }]],
    [["meta", { runId: "failed-run" }], ["delta", { text: "Partial" }], ["error", { message: "Failed" }], ["done", { status: "COMPLETED", completed: true }]],
  ] as StreamEvent[][]) {
    const harness = completionHarness(async () => streamResponse(events));
    await harness.render().handleSubmit({ preventDefault() {} });
    assert.equal(harness.render().slotA.completed, false);
    assert.equal(harness.render().qaHistoryId, null);
    assert.equal(harness.saved.length, 0);
    harness.unmount();
  }
});