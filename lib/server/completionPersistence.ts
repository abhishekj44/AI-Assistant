import type Database from "better-sqlite3";
import type { LLMRequestOptions, LLMStreamHandle } from "../llm/types";
import { createLLMStream, createParallelLLMStreams, getConfiguredTargets, type ParallelStreamHandle } from "../llm/providerRouter";
import { getDatabase } from "./db/connection";
import { ModelRunRepository, type ModelRequestInput, type RunSlot } from "./repositories/modelRunRepository";
import { QuestionRepository, type StoredQuestionInput } from "./repositories/questionRepository";

interface Dependencies {
  single?: typeof createLLMStream;
  parallel?: typeof createParallelLLMStreams;
  targets?: typeof getConfiguredTargets;
}
export const completionProviders = { single: createLLMStream, parallel: createParallelLLMStreams, targets: getConfiguredTargets };
export type DurableHandle = LLMStreamHandle & { runId: string };
export type DurableParallelHandle = ParallelStreamHandle & { runId: string };

export class CompletionPersistence {
  readonly requestId: string;
  readonly controller = new AbortController();
  private readonly runs: ModelRunRepository;
  private readonly pending = new Map<string, string>();

  constructor(
    input: ModelRequestInput,
    question?: Omit<StoredQuestionInput, "sessionId" | "mode">,
    database: Database.Database = getDatabase(),
    private readonly dependencies: Dependencies = {},
  ) {
    this.runs = new ModelRunRepository(database);
    this.requestId = database.transaction(() => {
      const questionId = question ? new QuestionRepository(database).create({ ...question, sessionId: input.sessionId, mode: input.mode }) : input.questionId;
      return this.runs.createRequest({ ...input, questionId });
    }).immediate();
  }

  interrupt(): void {
    this.controller.abort();
    for (const [id, output] of this.pending) this.runs.finish(id, { status: "INTERRUPTED", output, error: "Request interrupted" });
    this.pending.clear();
  }

  private start(slot: RunSlot, provider?: string, model?: string): string {
    const id = this.runs.start({ requestId: this.requestId, slot, provider, model });
    this.pending.set(id, "");
    return id;
  }

  private failed(id: string, error: unknown): void {
    this.runs.finish(id, { status: this.controller.signal.aborted ? "INTERRUPTED" : "FAILED", output: this.pending.get(id) || "", error: error instanceof Error ? error.message : String(error) });
    this.pending.delete(id);
  }

  private tracked(handle: LLMStreamHandle, id: string): DurableHandle {
    this.runs.configure(id, handle.provider, handle.model);
    const persistence = this;
    const stream = async function* () {
      let complete = false;
      let output = "";
      let checkpoint = performance.now();
      let usage: unknown;
      try {
        for await (const chunk of handle.stream) {
          if (persistence.controller.signal.aborted) throw new Error("Request interrupted");
          if (chunk.text) output += chunk.text;
          if (chunk.usage) usage = chunk.usage;
          persistence.pending.set(id, output);
          if (performance.now() - checkpoint >= 500) {
            persistence.runs.progress(id, output);
            checkpoint = performance.now();
          }
          yield chunk;
        }
        if (persistence.controller.signal.aborted) throw new Error("Request interrupted");
        if (!output.trim()) throw new Error("The provider returned an empty answer");
        persistence.runs.finish(id, { status: "COMPLETED", output, metrics: { usage }, autoSave: true });
        complete = true;
      } catch (error) {
        persistence.failed(id, error);
        throw error;
      } finally {
        if (!complete && persistence.pending.has(id)) {
          persistence.runs.finish(id, { status: "INTERRUPTED", output, error: "Stream closed before completion" });
        }
        persistence.pending.delete(id);
      }
    };
    return { ...handle, stream: stream(), runId: id };
  }

  async single(prompt: string, options: LLMRequestOptions): Promise<DurableHandle> {
    const id = this.start("SINGLE");
    try {
      const handle = await (this.dependencies.single || completionProviders.single)(prompt, { ...options, signal: this.controller.signal });
      if (this.controller.signal.aborted) throw new Error("Request interrupted");
      return this.tracked(handle, id);
    } catch (error) { this.failed(id, error); throw error; }
  }

  async parallel(prompt: string, options: LLMRequestOptions): Promise<DurableParallelHandle[]> {
    const ids = new Map<"A" | "B", string>();
    (this.dependencies.targets || completionProviders.targets)().forEach((target, index) => {
      const slot = index === 0 ? "A" : "B";
      ids.set(slot, this.start(slot, target.provider, target.model));
    });
    try {
      const handles = await (this.dependencies.parallel || completionProviders.parallel)(prompt, { ...options, signal: this.controller.signal });
      if (this.controller.signal.aborted) throw new Error("Request interrupted");
      for (const [slot, id] of ids) if (!handles.some((handle) => handle.slot === slot)) this.failed(id, new Error("Provider failed to connect"));
      return handles.map((handle) => ({ ...this.tracked(handle, ids.get(handle.slot) || this.start(handle.slot)), slot: handle.slot }));
    } catch (error) {
      for (const id of ids.values()) this.failed(id, error);
      throw error;
    }
  }

  metrics(runId: string, value: Record<string, unknown>): void { this.runs.updateMetrics(runId, value); }
}