import assert from "node:assert/strict";
import test from "node:test";
import type { GenerateContentParameters } from "@google/genai";
import { openDatabase } from "../lib/server/db/connection";
import { PromptRepository } from "../lib/server/repositories/promptRepository";
import { ModelRunRepository } from "../lib/server/repositories/modelRunRepository";
import { SessionRepository } from "../lib/server/repositories/sessionRepository";
import { EMPTY_MEETING_MEMORY } from "../lib/conversationTypes";
import { POST } from "../app/api/memory/route";

for (const outcome of ["valid", "outbox", "invalid", "failure", "abort"] as const) {
  test(`memory runtime prompt and ${outcome} audit`, async context => {
    const database = openDatabase(":memory:");
    context.after(() => database.close());
    const prompts = new PromptRepository(database);
    const runs = new ModelRunRepository(database);
    const sessions = new SessionRepository(database);
    const original = prompts.getActive("MEMORY", "MEETING");
    const active = prompts.update({ id: original.id, baseVersion: 1, system_template: "Custom memory style", user_template: "NEW MEMORY {{previousMemory}}\n{{recentTurns}}" });
    sessions.start({ id: "session", ownerTabId: "tab", sessionInfo: { callType: "meeting", company: "", details: "" } });
    const turns = [{ id: "turn", sequenceId: 1, speaker: "me" as const, text: 'Fact "quoted" {{literal}}', timestamp: new Date().toISOString() }];
    sessions.appendTurns("session", turns, "tab");
    const controller = new AbortController();
    context.mock.method(POST, "dependencies", () => ({ prompts, runs, sessions, generateContent: async (input: GenerateContentParameters) => {
      assert.match(String(input.contents), /NEW MEMORY/);
      assert.match(String(input.contents), /\\"quoted\\" \{\{literal\}\}/);
      assert.match(String(input.config?.systemInstruction), /Custom memory style/);
      assert.match(String(input.config?.systemInstruction), /Never invent facts/);
      assert.match(String(input.config?.systemInstruction), /CODE-OWNED OUTPUT CONTRACT/);
      assert.equal(input.config?.abortSignal?.aborted, false);
      assert.equal(input.config?.httpOptions?.timeout, 30_000);
      if (outcome === "failure") throw new Error("Mock unavailable");
      if (outcome === "abort") { controller.abort(); throw new DOMException("Aborted", "AbortError"); }
      return { text: outcome === "invalid" ? "null" : JSON.stringify({ ...EMPTY_MEETING_MEMORY, summary: "Updated memory" }) };
    } }));
    const response = await POST(new Request("http://localhost/api/memory", { method: "POST", signal: controller.signal, body: JSON.stringify({ previousMemory: EMPTY_MEETING_MEMORY, turns, sessionInfo: { callType: "meeting" }, ...(outcome === "outbox" ? {} : { sessionId: "session", ownerTabId: "tab", coveredThroughSequence: 1 }) }) }));
    const completed = outcome === "valid" || outcome === "outbox";
    assert.equal(response.status, completed ? 200 : 500);
    const request = database.prepare("SELECT * FROM model_requests WHERE purpose='MEMORY'").get() as { prompt_id: string };
    assert.equal(request.prompt_id, active.id);
    const run = database.prepare("SELECT * FROM model_runs").get() as { status: string; finished_at: string };
    assert.equal(run.status, completed ? "COMPLETED" : outcome === "abort" ? "INTERRUPTED" : "FAILED");
    assert.ok(run.finished_at);
    assert.equal(sessions.get("session")?.memory.summary, outcome === "valid" ? "Updated memory" : "");
    if (completed) assert.equal((await response.json()).memory.summary, "Updated memory");
  });
}

test("empty memory update preserves the previous response without model or database access", async context => {
  context.mock.method(POST, "dependencies", () => { throw new Error("Unexpected database access"); });
  const previousMemory = { ...EMPTY_MEETING_MEMORY, summary: "Previous memory" };
  const response = await POST(new Request("http://localhost/api/memory", { method: "POST", body: JSON.stringify({ previousMemory, turns: [] }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { memory: previousMemory });
});

test("interviewer memory retains candidate profile and both roles as separate evidence", async context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const prompts = new PromptRepository(database);
  const runs = new ModelRunRepository(database);
  const sessions = new SessionRepository(database);
  const sessionInfo = { company: "Example", details: "", callType: "taking_interview" as const, candidateProfile: "Candidate claims Python experience." };
  const timestamp = new Date().toISOString();
  const turns = [
    { id: "question", sequenceId: 1, speaker: "me" as const, text: "How do you test retries?", timestamp },
    { id: "answer", sequenceId: 2, speaker: "interviewer" as const, text: "I use fault injection.", timestamp },
  ];
  context.mock.method(POST, "dependencies", () => ({ prompts, runs, sessions, generateContent: async (input: GenerateContentParameters) => {
    assert.ok(String(input.contents).includes(sessionInfo.candidateProfile));
    assert.ok(String(input.contents).includes('"speaker":"me"'));
    assert.ok(String(input.contents).includes('"speaker":"candidate"'));
    assert.ok(String(input.contents).includes(turns[0].text));
    assert.ok(String(input.contents).includes(turns[1].text));
    return { text: JSON.stringify({ ...EMPTY_MEETING_MEMORY, summary: "Candidate discussed fault injection in response to a retry question." }) };
  } }));
  const response = await POST(new Request("http://localhost/api/memory", { method: "POST", body: JSON.stringify({ sessionInfo, turns, previousMemory: EMPTY_MEETING_MEMORY }) }));
  assert.equal(response.status, 200);
});