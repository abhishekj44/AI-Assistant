import { sessionRepository, type SessionRepository } from "./repositories/sessionRepository";
import { createLLMStream } from "../llm/providerRouter";
import { formatTranscriptForSummary } from "../prompts/summarizer";
import { renderRuntimePrompt } from "./runtimePrompts";
import { promptRepository, type PromptRepository } from "./repositories/promptRepository";
import { ModelRunRepository } from "./repositories/modelRunRepository";
import { interviewContextBlock } from "../interviewContext";

export async function processSessionJobs(
  repository: SessionRepository = sessionRepository,
  options: { maxJobs?: number; timeoutMs?: number; createStream?: typeof createLLMStream; promptRepository?: PromptRepository; modelRunRepository?: ModelRunRepository } = {},
): Promise<number> {
  if (repository !== sessionRepository && (!options.promptRepository || !options.modelRunRepository)) {
    throw new Error("Injected sessions require prompt and model-run repositories from the same database");
  }
  let processed = 0;
  for (let index = 0; index < Math.min(3, Math.max(1, options.maxJobs ?? 2)); index += 1) {
    const job = repository.claimJob();
    if (!job) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const controller = new AbortController();
    let runId: string | undefined;
    let output = "";
    let runs: ModelRunRepository | undefined;
    try {
      const session = repository.get(job.session_id);
      if (!session) throw new Error("Summary session not found");
      const coverage = JSON.parse(job.parameters_json).coveredThroughSequence as number;
      const callType = session.sessionInfo?.callType ?? "meeting";
      const generate = async () => {
        if (!coverage) return "";
        const transcript = formatTranscriptForSummary(session.transcripts.filter(turn => turn.sequenceId <= coverage), callType, 35_000);
        const rendered = renderRuntimePrompt("SUMMARY", session.sessionInfo, { transcript,
          jobDescription: session.sessionInfo?.jobDescription || "", candidateProfile: session.sessionInfo?.candidateProfile || "" }, options.promptRepository ?? promptRepository);
        const prompt = [rendered.prompt, interviewContextBlock(session.sessionInfo)].filter(Boolean).join("\n\n");
        runs = options.modelRunRepository ?? new ModelRunRepository();
        const requestId = runs.createRequest({ ...rendered, prompt, mode: rendered.mode ?? undefined, sessionId: session.id, purpose: "SUMMARY", context: { jobId: job.id, sessionInfo: session.sessionInfo, coveredThroughSequence: coverage, promptVersion: rendered.promptVersion } });
        runId = runs.start({ requestId, attempt: job.attempts, tag: "Session Summary" });
        const handle = await (options.createStream ?? createLLMStream)(prompt, { sessionId: session.id, maxOutputTokens: 1500, systemInstruction: rendered.systemInstruction, signal: controller.signal });
        runs.configure(runId, handle.provider, handle.model);
        if (expired) throw new Error("Summary timed out");
        for await (const chunk of handle.stream) {
          if (expired) throw new Error("Summary timed out");
          output += chunk.text ?? "";
          if (output.length > 64_000) throw new Error("Summary output exceeds limit");
        }
        if (expired) throw new Error("Summary timed out");
        if (!output.trim()) throw new Error("Empty summary response");
        return output.trim();
      };
      const summary = await Promise.race([generate(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; controller.abort(); reject(new Error("Summary timed out")); }, Math.min(60_000, Math.max(1, options.timeoutMs ?? 60_000)));
      })]);
      repository.completeJob(job, summary);
      if (runId) runs!.finish(runId, { status: "COMPLETED", output: summary });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runId) runs!.finish(runId, { status: expired ? "INTERRUPTED" : "FAILED", output, error: message });
      repository.failJob(job, message);
    } finally {
      if (timer) clearTimeout(timer);
    }
    processed += 1;
  }
  return processed;
}