import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { SessionRepository } from "../lib/server/repositories/sessionRepository";
import { PromptRepository } from "../lib/server/repositories/promptRepository";
import { ModelRunRepository } from "../lib/server/repositories/modelRunRepository";
import { processSessionJobs } from "../lib/server/sessionJobs";
import { extractKnowledgeSourceWithData } from "../lib/server/knowledgeExtractor";

test("summary timeout persists interruption and late provider cannot complete the job", async context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new SessionRepository(database);
  const prompts = new PromptRepository(database);
  const runs = new ModelRunRepository(database);
  repository.start({ id: "session", ownerTabId: "tab" });
  repository.end("session", "tab", [{ id: "turn", sequenceId: 1, speaker: "me", text: "Fact", timestamp: new Date().toISOString() }]);
  let connect!: (handle: Awaited<ReturnType<typeof import("../lib/llm/providerRouter").createLLMStream>>) => void;
  const connection = new Promise<Awaited<ReturnType<typeof import("../lib/llm/providerRouter").createLLMStream>>>(resolve => { connect = resolve; });
  await processSessionJobs(repository, { promptRepository: prompts, modelRunRepository: runs, timeoutMs: 1, maxJobs: 1, createStream: () => connection });
  connect({ provider: "gemini", model: "mock", stream: (async function* () { yield { text: "Late output" }; })() });
  await Promise.resolve();
  const run = database.prepare("SELECT * FROM model_runs").get() as { status: string; error: string; finished_at: string };
  assert.equal(run.status, "INTERRUPTED");
  assert.match(run.error, /timed out/);
  assert.ok(run.finished_at);
  assert.equal(repository.get("session")?.summary, undefined);
  assert.equal(repository.get("session")?.status, "ENDED");
  assert.equal((database.prepare("SELECT status FROM background_jobs").get() as { status: string }).status, "PENDING");
});

for (const failure of [false, true]) {
  test(`summary runtime version and ${failure ? "failed" : "completed"} audit`, async context => {
    const database = openDatabase(":memory:");
    context.after(() => database.close());
    const repository = new SessionRepository(database);
    const prompts = new PromptRepository(database);
    const runs = new ModelRunRepository(database);
    const original = prompts.getActive("SUMMARY", "MEETING");
    const active = prompts.update({ id: original.id, baseVersion: 1, system_template: "Custom summary style", user_template: "NEW SUMMARY {{transcript}}" });
    repository.start({ id: "session", ownerTabId: "tab", sessionInfo: { callType: "meeting", company: "", details: "" } });
    repository.end("session", "tab", [{ id: "turn", sequenceId: 1, speaker: "me", text: "Verified fact", timestamp: new Date().toISOString() }]);
    assert.equal(repository.get("session")?.status, "ENDED");
    const processed = await processSessionJobs(repository, { promptRepository: prompts, modelRunRepository: runs, maxJobs: 1, createStream: async (prompt, options) => {
      assert.match(prompt, /NEW SUMMARY.*Verified fact/s);
      assert.match(options?.systemInstruction ?? "", /Custom summary style/);
      assert.match(options?.systemInstruction ?? "", /Never invent facts/);
      if (failure) throw new Error("Mock unavailable");
      return { provider: "gemini", model: "mock", stream: (async function* () { yield { text: "Updated summary" }; })() };
    } });
    assert.equal(processed, 1);
    const request = database.prepare("SELECT * FROM model_requests WHERE purpose='SUMMARY'").get() as { prompt_id: string; rendered_user_text: string };
    assert.equal(request.prompt_id, active.id);
    assert.match(request.rendered_user_text, /NEW SUMMARY/);
    const run = database.prepare("SELECT * FROM model_runs").get() as { status: string; output_text: string; finished_at: string };
    assert.equal(run.status, failure ? "FAILED" : "COMPLETED");
    assert.ok(run.finished_at);
    assert.equal(repository.get("session")?.summary, failure ? undefined : "Updated summary");
    assert.equal(repository.get("session")?.transcripts.length, 1);
  });
}

for (const failure of [false, true]) {
  test(`extraction active prompt and ${failure ? "failed" : "completed"} audit without source writes`, async context => {
    const database = openDatabase(":memory:");
    context.after(() => database.close());
    const prompts = new PromptRepository(database);
    const runs = new ModelRunRepository(database);
    const original = prompts.getActive("EXTRACTION");
    const active = prompts.update({ id: original.id, baseVersion: 1, system_template: "Custom extraction style", user_template: "NEW EXTRACTION {{documentType}} {{documentText}}" });
    const result = extractKnowledgeSourceWithData(new File(['Document "quoted" {{literal}}'], "resume.txt", { type: "text/plain" }), "resume", {
      promptRepository: prompts, modelRunRepository: runs, generateContent: async input => {
        assert.equal(input.contents, 'NEW EXTRACTION resume Document "quoted" {{literal}}');
        assert.match(String(input.config?.systemInstruction), /Custom extraction style/);
        assert.match(String(input.config?.systemInstruction), /Never invent facts/);
        if (failure) throw new Error("Mock extraction unavailable");
        return { text: JSON.stringify({ sourceSummary: "Verified source", facts: ["Evidence"], keywords: [] }) };
      },
    });
    if (failure) await assert.rejects(result, /Mock extraction unavailable/);
    else assert.equal((await result).source.summary, "Verified source");
    const request = database.prepare("SELECT * FROM model_requests WHERE purpose='EXTRACTION'").get() as { prompt_id: string };
    assert.equal(request.prompt_id, active.id);
    const run = database.prepare("SELECT * FROM model_runs").get() as { status: string; finished_at: string };
    assert.equal(run.status, failure ? "FAILED" : "COMPLETED");
    assert.ok(run.finished_at);
    assert.equal((database.prepare("SELECT count(*) AS count FROM knowledge_documents").get() as { count: number }).count, 0);
  });
}

test("interview summary includes the session candidate profile and both speakers", async context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new SessionRepository(database);
  const prompts = new PromptRepository(database);
  const runs = new ModelRunRepository(database);
  repository.start({ id: "taking", ownerTabId: "tab", sessionInfo: { company: "Example", details: "", callType: "taking_interview", candidateProfile: "Candidate claims Redis experience." } });
  const timestamp = new Date().toISOString();
  repository.end("taking", "tab", [
    { id: "question", sequenceId: 1, speaker: "me", text: "How do you handle cache expiry?", timestamp },
    { id: "answer", sequenceId: 2, speaker: "interviewer", text: "I stagger the expirations.", timestamp },
  ]);
  await processSessionJobs(repository, { promptRepository: prompts, modelRunRepository: runs, maxJobs: 1, createStream: async prompt => {
    assert.ok(prompt.includes("Candidate claims Redis experience."));
    assert.ok(prompt.includes("How do you handle cache expiry?"));
    assert.ok(prompt.includes("I stagger the expirations."));
    return { provider: "gemini", model: "mock", stream: (async function* () { yield { text: "The candidate discussed staggered expirations." }; })() };
  } });
  assert.equal(repository.get("taking")?.summaryStatus, "READY");
});