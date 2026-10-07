import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { SessionRepository } from "../lib/server/repositories/sessionRepository";
import { PromptRepository } from "../lib/server/repositories/promptRepository";
import { ModelRunRepository } from "../lib/server/repositories/modelRunRepository";
import { generateSessionSummary } from "../lib/server/sessionSummary";
import { extractKnowledgeSourceWithData } from "../lib/server/knowledgeExtractor";

type Stream = Awaited<ReturnType<typeof import("../lib/llm/providerRouter").createLLMStream>>;
const answer = (text: string): Stream => ({ provider: "gemini", model: "mock", stream: (async function* () { yield { text }; })() });
const turn = (id: string, sequenceId: number, text: string, speaker: "me" | "interviewer" = "me") => ({ id, sequenceId, speaker, text, timestamp: new Date().toISOString() });

function endedSession(database: ReturnType<typeof openDatabase>, turns = [turn("turn", 1, "Verified fact")], sessionInfo: Parameters<SessionRepository["start"]>[0]["sessionInfo"] = { callType: "meeting", company: "", details: "" }) {
  const repository = new SessionRepository(database);
  repository.start({ id: "session", ownerTabId: "tab", sessionInfo });
  repository.end("session", "tab", turns);
  return { repository, prompts: new PromptRepository(database), runs: new ModelRunRepository(database) };
}

test("a summary that times out is marked failed, a late provider cannot complete it, and Retry succeeds", async context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const { repository, prompts, runs } = endedSession(database);
  const covered = repository.claimSummary("session")!;
  let connect!: (handle: Stream) => void;
  const connection = new Promise<Stream>(resolve => { connect = resolve; });
  await generateSessionSummary("session", covered, { repository, promptRepository: prompts, modelRunRepository: runs, timeoutMs: 1, createStream: () => connection });
  connect(answer("Late output"));
  await new Promise(resolve => setImmediate(resolve));
  const run = database.prepare("SELECT * FROM model_runs").get() as { status: string; error: string; finished_at: string };
  assert.equal(run.status, "INTERRUPTED");
  assert.match(run.error, /timed out/);
  assert.ok(run.finished_at);
  const failed = repository.get("session")!;
  assert.equal(failed.summary, undefined);
  assert.equal(failed.summaryStatus, "FAILED");
  assert.match(failed.summaryError!, /timed out/);
  assert.equal(failed.status, "ENDED");
  const retry = repository.claimSummary("session", true)!;
  await generateSessionSummary("session", retry, { repository, promptRepository: prompts, modelRunRepository: runs, createStream: async () => answer("Recovered summary") });
  const recovered = repository.get("session")!;
  assert.equal(recovered.summary, "Recovered summary");
  assert.equal(recovered.summaryStatus, "READY");
  assert.equal(recovered.summaryError, undefined);
});

for (const failure of [false, true]) {
  test(`summary uses the saved prompt and records a ${failure ? "failed" : "completed"} audit`, async context => {
    const database = openDatabase(":memory:");
    context.after(() => database.close());
    const { repository, prompts, runs } = endedSession(database);
    const original = prompts.get("SUMMARY", "MEETING");
    prompts.update({ key: original.template_key, system_template: "Custom summary style", user_template: "NEW SUMMARY {{transcript}}" });
    const covered = repository.claimSummary("session")!;
    await generateSessionSummary("session", covered, { repository, promptRepository: prompts, modelRunRepository: runs, createStream: async (prompt, options) => {
      assert.match(prompt, /NEW SUMMARY.*Verified fact/s);
      assert.match(options?.systemInstruction ?? "", /Custom summary style/);
      assert.match(options?.systemInstruction ?? "", /Never invent facts/);
      if (failure) throw new Error("Mock unavailable");
      return answer("Updated summary");
    } });
    const request = database.prepare("SELECT * FROM model_requests WHERE purpose='SUMMARY'").get() as { prompt_key: string; rendered_user_text: string };
    assert.equal(request.prompt_key, original.template_key);
    assert.match(request.rendered_user_text, /NEW SUMMARY/);
    const run = database.prepare("SELECT * FROM model_runs").get() as { status: string; output_text: string; finished_at: string };
    assert.equal(run.status, failure ? "FAILED" : "COMPLETED");
    assert.ok(run.finished_at);
    const stored = repository.get("session")!;
    assert.equal(stored.summary, failure ? undefined : "Updated summary");
    assert.equal(stored.summaryStatus, failure ? "FAILED" : "READY");
    if (failure) assert.match(stored.summaryError!, /Mock unavailable/);
    assert.equal(stored.transcripts.length, 1);
  });
}

test("a summary covers only the turns present when it started and the later turn is flagged as not covered", async context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const { repository, prompts, runs } = endedSession(database, [turn("one", 1, "First topic"), turn("two", 2, "Second topic")]);
  const covered = repository.claimSummary("session")!;
  assert.equal(covered, 2);
  repository.appendTurns("session", [turn("three", 3, "Late afterthought")], "tab");
  await generateSessionSummary("session", covered, { repository, promptRepository: prompts, modelRunRepository: runs, createStream: async prompt => {
    assert.ok(prompt.includes("First topic") && prompt.includes("Second topic"));
    assert.ok(!prompt.includes("Late afterthought"));
    return answer("Summary of two turns");
  } });
  const stored = repository.get("session")!;
  assert.equal(stored.summaryStatus, "READY");
  assert.equal(stored.summaryThroughSequence, 2);
  assert.equal(stored.throughSequence, 3);
  const updated = repository.claimSummary("session", true)!;
  assert.equal(updated, 3);
  await generateSessionSummary("session", updated, { repository, promptRepository: prompts, modelRunRepository: runs, createStream: async prompt => {
    assert.ok(prompt.includes("Late afterthought"));
    return answer("Summary of three turns");
  } });
  assert.equal(repository.get("session")!.summaryThroughSequence, 3);
  assert.equal((database.prepare("SELECT count(*) AS count FROM retrieval_items WHERE summary_session_id = 'session'").get() as { count: number }).count, 1);
});

for (const failure of [false, true]) {
  test(`extraction saved prompt and ${failure ? "failed" : "completed"} audit without source writes`, async context => {
    const database = openDatabase(":memory:");
    context.after(() => database.close());
    const prompts = new PromptRepository(database);
    const runs = new ModelRunRepository(database);
    const original = prompts.get("EXTRACTION");
    prompts.update({ key: original.template_key, system_template: "Custom extraction style", user_template: "NEW EXTRACTION {{documentType}} {{documentText}}" });
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
    const request = database.prepare("SELECT * FROM model_requests WHERE purpose='EXTRACTION'").get() as { prompt_key: string };
    assert.equal(request.prompt_key, original.template_key);
    const run = database.prepare("SELECT * FROM model_runs").get() as { status: string; finished_at: string };
    assert.equal(run.status, failure ? "FAILED" : "COMPLETED");
    assert.ok(run.finished_at);
    assert.equal((database.prepare("SELECT count(*) AS count FROM knowledge_documents").get() as { count: number }).count, 0);
  });
}

test("interview summary includes the session candidate profile and both speakers", async context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const { repository, prompts, runs } = endedSession(database, [
    turn("question", 1, "How do you handle cache expiry?"),
    turn("answer", 2, "I stagger the expirations.", "interviewer"),
  ], { company: "Example", details: "", callType: "taking_interview", candidateProfile: "Candidate claims Redis experience." });
  const covered = repository.claimSummary("session")!;
  await generateSessionSummary("session", covered, { repository, promptRepository: prompts, modelRunRepository: runs, createStream: async prompt => {
    assert.ok(prompt.includes("Candidate claims Redis experience."));
    assert.ok(prompt.includes("How do you handle cache expiry?"));
    assert.ok(prompt.includes("I stagger the expirations."));
    return answer("The candidate discussed staggered expirations.");
  } });
  assert.equal(repository.get("session")?.summaryStatus, "READY");
});
