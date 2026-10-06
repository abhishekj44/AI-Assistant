import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { ModelRunRepository } from "../lib/server/repositories/modelRunRepository";
import { QuestionRepository } from "../lib/server/repositories/questionRepository";

test("model slots persist independently and incomplete answers cannot be approved", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const questions = new QuestionRepository(database);
  const runs = new ModelRunRepository(database);
  const questionId = questions.create({ question: "How would you scale a queue?", mode: "INTERVIEWEE" });
  const requestId = runs.createRequest({ purpose: "ANSWER", questionId, prompt: "Answer", mode: "INTERVIEWEE" });
  const slotA = runs.start({ requestId, slot: "A", provider: "gemini", model: "primary" });
  const slotB = runs.start({ requestId, slot: "B", provider: "groq", model: "backup" });
  runs.progress(slotA, "Partial answer");
  runs.finish(slotA, { status: "INTERRUPTED", output: "Partial answer", autoSave: true });
  runs.finish(slotB, { status: "COMPLETED", output: "Partition the queue.", metrics: { outputTokens: 7 }, autoSave: true });
  assert.throws(() => runs.rate(slotA, "good"), /completed/);
  assert.equal(runs.get(slotA)?.status, "INTERRUPTED");
  assert.equal(runs.get(slotA)?.savedAt, undefined);
  assert.equal(runs.get(slotB)?.question, "How would you scale a queue?");
  assert.deepEqual(runs.get(slotB)?.metrics, { outputTokens: 7 });
  assert.equal(runs.list(30, { savedOnly: true }).length, 1);
  assert.equal(runs.rate(slotB, "good").feedback, "good");
  runs.setSaved(slotB, false);
  assert.equal(runs.list(30, { savedOnly: true }).length, 0);
});

test("legacy history imports once without changing feedback or timestamps", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const runs = new ModelRunRepository(database);
  const entries = [{ id: "old-answer", question: "Why SQLite?", answer: "Local transactions", callType: "giving_interview", feedback: "good", createdAt: "2021-01-02T03:04:05.000Z", feedbackAt: "2021-02-01T00:00:00.000Z" }];
  assert.equal(runs.importHistory(entries), 1);
  assert.equal(runs.importHistory(entries), 0);
  const [entry] = runs.history();
  assert.equal(entry.createdAt, entries[0].createdAt);
  assert.equal(entry.feedbackAt, entries[0].feedbackAt);
  assert.equal(entry.feedback, "good");
  assert.equal(entry.question, entries[0].question);
  assert.equal(entry.status, "COMPLETED");
  assert.throws(() => runs.importHistory([{ ...entries[0], id: "new-answer" }, { id: "invalid" }]), /require/);
  assert.equal(runs.get("new-answer"), null);
});

test("recovery interrupts abandoned runs without stopping a living process", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const runs = new ModelRunRepository(database);
  const requestId = runs.createRequest({ purpose: "ANSWER", prompt: "Question" });
  const dead = runs.start({ requestId, slot: "A" });
  const live = runs.start({ requestId, slot: "B" });
  runs.progress(dead, "Partial output");
  database.prepare("UPDATE model_runs SET owner_pid=42 WHERE id=?").run(dead);
  assert.equal(runs.recoverInterruptedRuns(pid => pid === process.pid), 1);
  assert.equal(runs.get(dead)?.status, "INTERRUPTED");
  assert.equal(runs.get(dead)?.output, "Partial output");
  assert.equal(runs.get(live)?.status, "RUNNING");
});