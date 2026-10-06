import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { CompletionPersistence } from "../lib/server/completionPersistence";
import { ModelRunRepository } from "../lib/server/repositories/modelRunRepository";

test("durable streaming commits completed slots and retains interrupted partial output", async (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const runs = new ModelRunRepository(database);
  const persistence = new CompletionPersistence({ purpose: "ANSWER", prompt: "Answer", mode: "INTERVIEWEE" }, { question: "Why WAL?" }, database, {
    targets: () => [{ provider: "gemini", model: "fast" }, { provider: "groq", model: "backup" }],
    parallel: async () => [
      { slot: "A", provider: "gemini", model: "fast", stream: (async function* () { yield { text: "Readable commits" }; })() },
      { slot: "B", provider: "groq", model: "backup", stream: (async function* () { yield { text: "Partial" }; yield { text: " tail" }; })() },
    ],
  });
  const [primary, backup] = await persistence.parallel("Answer", {});
  for await (const _chunk of primary.stream) {}
  assert.equal(runs.get(primary.runId)?.status, "COMPLETED");
  assert.ok(runs.get(primary.runId)?.savedAt);
  const iterator = backup.stream[Symbol.asyncIterator]();
  await iterator.next();
  persistence.interrupt();
  await iterator.return?.();
  assert.equal(runs.get(backup.runId)?.status, "INTERRUPTED");
  assert.equal(runs.get(backup.runId)?.output, "Partial");
  assert.equal(runs.get(backup.runId)?.savedAt, undefined);
  assert.equal(runs.history().length, 2);
});

test("empty and failed provider starts cannot become saved answers", async (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const empty = new CompletionPersistence({ purpose: "ANSWER", prompt: "Answer" }, undefined, database, {
    single: async () => ({ provider: "gemini", model: "fake", stream: (async function* () {})() }),
  });
  const handle = await empty.single("Answer", {});
  await assert.rejects(async () => { for await (const _chunk of handle.stream) {} }, /empty/);
  assert.equal(new ModelRunRepository(database).get(handle.runId)?.status, "FAILED");
  const failed = new CompletionPersistence({ purpose: "ANSWER", prompt: "Answer" }, undefined, database, {
    single: async () => { throw new Error("No credentials"); },
  });
  await assert.rejects(failed.single("Answer", {}), /credentials/);
  assert.equal(database.prepare<[], { count: number }>("SELECT count(*) AS count FROM model_runs WHERE status='FAILED' AND saved_at IS NULL").get()!.count, 2);
});