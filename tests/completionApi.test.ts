import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { POST } from "../app/api/completion/route";
import { getDatabase } from "../lib/server/db/connection";
import { completionProviders } from "../lib/server/completionPersistence";
import { PromptRepository } from "../lib/server/repositories/promptRepository";
import { KnowledgeRepository } from "../lib/server/repositories/knowledgeRepository";
import { ModelRunRepository } from "../lib/server/repositories/modelRunRepository";
import { EMPTY_KNOWLEDGE_PACK } from "../lib/knowledge/types";

test("live route uses FTS context and prompt versions, committing before the completed SSE event", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-completion-"));
  const cwd = process.cwd();
  const previousPath = process.env.COPILOT_DB_PATH;
  process.chdir(root);
  process.env.COPILOT_DB_PATH = path.join(root, "test.db");
  const database = getDatabase();
  context.after(() => {
    database.close();
    process.chdir(cwd);
    if (previousPath) process.env.COPILOT_DB_PATH = previousPath;
    else delete process.env.COPILOT_DB_PATH;
    fs.rmSync(root, { recursive: true, force: true });
  });
  new KnowledgeRepository(database).replacePack({ ...structuredClone(EMPTY_KNOWLEDGE_PACK), facts: ["I use SQLite for local transactions."] });
  const prompts = new PromptRepository(database);
  const seed = prompts.getActive("ANSWER", "INTERVIEWEE");
  const active = prompts.update({ id: seed.id, baseVersion: seed.version, system_template: "Speak clearly.", user_template: "Explain the practical trade-off." });
  context.mock.method(completionProviders, "targets", () => [{ provider: "gemini", model: "mock" }]);
  context.mock.method(completionProviders, "parallel", async (prompt: string, options: { systemInstruction?: string }) => {
    assert.ok(prompt.includes("SQLite for local transactions"));
    assert.ok(prompt.includes("<JOB_DESCRIPTION_DATA>"));
    assert.ok(prompt.includes("Design reliable database storage"));
    assert.ok(prompt.endsWith("Explain the practical trade-off."));
    assert.ok(options.systemInstruction?.includes("Speak clearly."));
    return [{ provider: "gemini", model: "mock", slot: "A", stream: (async function* () { yield { text: "Use WAL and short transactions." }; })() }];
  });
  const request = new Request("http://localhost/api/completion", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    flag: "copilot", focusQuestion: "Why SQLite?", sessionId: "session", ownerTabId: "tab",
    sessionInfo: { callType: "giving_interview", company: "Example", details: "", jobDescription: "Design reliable database storage" },
    recentTurns: [{ id: "turn", sequenceId: 1, speaker: "interviewer", text: "Why SQLite?", timestamp: new Date().toISOString() }],
  }) });
  const response = await POST(request);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.includes("event: done_a"), text);
  const done = text.split("\n\n").find(block => block.startsWith("event: done_a"))!;
  const payload = JSON.parse(done.split("data: ")[1]);
  const run = new ModelRunRepository(database).get(payload.runId)!;
  assert.equal(run.status, "COMPLETED");
  assert.ok(run.savedAt);
  assert.equal(run.output, "Use WAL and short transactions.");
  assert.equal(run.metrics.retrievalEngine, "sqlite-fts5+lexical");
  assert.equal((database.prepare("SELECT prompt_id FROM model_requests WHERE id = ?").get(run.requestId) as { prompt_id: string }).prompt_id, active.id);
  assert.equal((database.prepare("SELECT count(*) AS count FROM transcript_turns").get() as { count: number }).count, 1);
});

test("Taking Interview evaluates the stored candidate profile against both speakers, never the local resume", async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-taking-"));
  const cwd = process.cwd();
  const previousPath = process.env.COPILOT_DB_PATH;
  process.chdir(root);
  process.env.COPILOT_DB_PATH = path.join(root, "test.db");
  const database = getDatabase();
  context.after(() => {
    database.close(); process.chdir(cwd);
    if (previousPath) process.env.COPILOT_DB_PATH = previousPath;
    else delete process.env.COPILOT_DB_PATH;
    fs.rmSync(root, { recursive: true, force: true });
  });
  new KnowledgeRepository(database).replacePack({ ...structuredClone(EMPTY_KNOWLEDGE_PACK), facts: ["LOCAL_RESUME_DO_NOT_USE"] });
  context.mock.method(completionProviders, "targets", () => [{ provider: "gemini", model: "mock" }]);
  context.mock.method(completionProviders, "parallel", async (prompt: string, options: { systemInstruction?: string }) => {
    assert.ok(prompt.includes("Candidate: Redis developer, three years of experience."));
    assert.ok(prompt.includes("ME: How did you measure queue latency?"));
    assert.ok(prompt.includes("CANDIDATE: We measured the p95 wait time."));
    assert.ok(prompt.includes("ME: What did you do when that metric increased?"));
    assert.ok(prompt.includes("<CANDIDATE_RESPONSE_DATA>\nWe measured the p95 wait time."));
    assert.ok(!prompt.includes("LOCAL_RESUME_DO_NOT_USE"));
    assert.ok(!options.systemInstruction?.includes("LOCAL_RESUME_DO_NOT_USE"));
    assert.ok(options.systemInstruction?.includes("conversation between both speakers"));
    return [{ provider: "gemini", model: "mock", slot: "A", stream: (async function* () { yield { text: "Ask which failure modes the candidate investigated." }; })() }];
  });
  const timestamp = new Date().toISOString();
  const response = await POST(new Request("http://localhost/api/completion", { method: "POST", body: JSON.stringify({
    flag: "copilot", sessionId: "taking", ownerTabId: "tab", bg: "LOCAL_RESUME_DO_NOT_USE",
    sessionInfo: { company: "Example", details: "Backend interview", callType: "taking_interview",
      candidateProfile: "Candidate: Redis developer, three years of experience.", knowledgeBaseIds: ["personal-knowledge"] },
    recentTurns: [
      { id: "local-question", sequenceId: 1, speaker: "me", text: "How did you measure queue latency?", timestamp },
      { id: "remote-answer", sequenceId: 2, speaker: "interviewer", text: "We measured the p95 wait time.", timestamp },
      { id: "local-followup", sequenceId: 3, speaker: "me", text: "What did you do when that metric increased?", timestamp },
    ],
  }) }));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.includes("event: done_a"), text);
  const run = new ModelRunRepository(database).list()[0];
  assert.equal(run.mode, "INTERVIEWER");
  assert.equal(run.question, "We measured the p95 wait time.");
  assert.equal(run.metrics.retrievalEngine, "disabled");
  assert.equal(database.prepare("SELECT 1 FROM session_knowledge_bases WHERE session_id='taking'").get(), undefined);
  const stored = database.prepare("SELECT candidate_profile FROM sessions WHERE id='taking'").get() as { candidate_profile: string };
  assert.equal(stored.candidate_profile, "Candidate: Redis developer, three years of experience.");
  for (const callType of ["giving_interview", "taking_interview"]) {
    const missing = await POST(new Request("http://localhost/api/completion", { method: "POST", body: JSON.stringify({ flag: "copilot", sessionInfo: { callType, company: "", details: "" } }) }));
    assert.equal(missing.status, 400);
  }
});