import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { ChatRepository, createChatHandlers } from "../lib/server/repositories/chatRepository";
import { PromptRepository } from "../lib/server/repositories/promptRepository";
import { ModelRunRepository } from "../lib/server/repositories/modelRunRepository";

test("chat API persists failures, ignores browser history and replays completed replies", async (context) => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const chats = new ChatRepository(db);
  const prompts = new PromptRepository(db);
  const row = prompts.getActive("CHAT");
  const active = prompts.update({ id: row.id, baseVersion: 1, system_template: "Custom chat", user_template: "{{history}}USER: {{message}}" });
  let calls = 0;
  const api = createChatHandlers({ chats, prompts, context: async () => "", generate: async (prompt) => {
    calls++;
    assert.ok(prompt.includes("USER: Hello"));
    assert.ok(!prompt.includes("FAKE HISTORY"));
    if (calls === 1) throw new Error("Missing cloud credentials");
    return { provider: "gemini", model: "fake", stream: (async function* () { yield { text: "Hello back" }; })() };
  } });
  const request = () => new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ threadId: "thread", clientMessageId: "client", message: "Hello", history: [{ sender: "bot", text: "FAKE HISTORY" }] }) });
  assert.equal((await api.POST(request())).status, 503);
  assert.equal(chats.getMessages("thread")[0].content, "Hello");
  assert.equal((await api.POST(request())).status, 200);
  prompts.update({ id: active.id, baseVersion: active.version, system_template: "Changed after generation", user_template: "{{candidateContext}}" });
  assert.equal((await api.POST(request())).status, 200);
  assert.equal(calls, 2);
  assert.equal(chats.getMessages("thread").length, 2);
  const stored = db.prepare("SELECT prompt_id FROM model_requests ORDER BY rowid DESC LIMIT 1").get() as { prompt_id: string };
  assert.equal(stored.prompt_id, active.id);
  const page = await (await api.GET(new Request("http://localhost/api/chat?threadId=thread&limit=1"))).json();
  assert.equal(page.messages[0].role, "ASSISTANT");
  assert.equal((await api.DELETE(new Request("http://localhost/api/chat?threadId=thread", { method: "DELETE" }))).status, 200);
  assert.equal(chats.getThread("thread"), undefined);
});

test("chat uses persisted chronology and retains interrupted partial output", async (context) => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const chats = new ChatRepository(db);
  const prompts = new PromptRepository(db);
  chats.createThread({ id: "thread" });
  chats.append({ id: "older", threadId: "thread", role: "USER", content: "Persisted question" });
  chats.append({ id: "reply", threadId: "thread", role: "ASSISTANT", content: "Persisted answer" });
  const controller = new AbortController();
  const api = createChatHandlers({ chats, prompts, context: async () => "", generate: async (prompt) => {
    assert.ok(prompt.includes("USER: Persisted question\nASSISTANT: Persisted answer"));
    return { provider: "gemini", model: "fake", stream: (async function* () { yield { text: "Partial" }; controller.abort(); })() };
  } });
  const response = await api.POST(new Request("http://localhost/api/chat", { method: "POST", signal: controller.signal, body: JSON.stringify({ threadId: "thread", clientMessageId: "next", message: "Follow up" }) }));
  assert.equal(response.status, 503);
  const run = chats.getMessageRun("thread:next");
  assert.equal(run?.status, "INTERRUPTED");
  assert.equal(run?.output, "Partial");
  assert.equal(chats.getMessages("thread").length, 3);
});

test("chat run claims prevent duplicate generation and retain failed input", (context) => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const repo = new ChatRepository(db);
  const prompt = new PromptRepository(db).getActive("CHAT");
  repo.createThread({ id: "thread" });
  repo.append({ id: "user", threadId: "thread", role: "USER", content: "Question" });
  const request = { purpose: "CHAT" as const, prompt: "Question", promptId: prompt.id };
  const first = repo.claimRun("user", request);
  assert.equal(first.claimed, true);
  assert.equal(repo.claimRun("user", request).claimed, false);
  repo.finishRun(first.runId, { status: "FAILED", output: "", error: "Missing credentials" });
  assert.equal(new ModelRunRepository(db).get(first.runId)?.status, "FAILED");
  const second = repo.claimRun("user", request);
  assert.equal(second.claimed, true);
  repo.complete("user", second.runId, "Answer");
  assert.equal(repo.claimRun("user", request).output, "Answer");
  assert.equal(repo.claimRun("user", request).claimed, false);
  assert.equal(repo.getMessages("thread")[0].run_id, second.runId);
  const page = repo.page("thread", 1);
  assert.equal(page.messages[0].role, "ASSISTANT");
  assert.equal(repo.page("thread", 1, page.nextBefore!).messages[0].role, "USER");
});

test("chat retries are idempotent and restoration uses chronological insertion order", (context) => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const repo = new ChatRepository(db);
  const thread = repo.createThread({ id: "thread", title: "Question" });
  const message = { id: "z-user", threadId: thread.id, role: "USER" as const, content: "Question" };
  repo.append(message);
  repo.append(message);
  repo.append({ id: "a-assistant", threadId: thread.id, role: "ASSISTANT", content: "Answer" });
  db.prepare("UPDATE chat_messages SET created_at=?").run("2026-01-01T00:00:00.000Z");
  assert.deepEqual(repo.getMessages(thread.id).map((row) => row.id), ["z-user", "a-assistant"]);
  assert.equal(repo.listThreads()[0].id, thread.id);
  assert.equal(new ChatRepository(db).getMessages(thread.id).length, 2);
  assert.throws(() => repo.append({ ...message, content: "Different" }), /already used/);
});