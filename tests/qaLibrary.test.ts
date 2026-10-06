import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { AnswerLibraryRepository } from "../lib/server/repositories/answerLibraryRepository";
import { KnowledgeRepository } from "../lib/server/repositories/knowledgeRepository";
import { EMPTY_KNOWLEDGE_PACK } from "../lib/knowledge/types";

test("Q&A retains more than UI limits, timestamps and transactional FTS", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new AnswerLibraryRepository(database);
  const entries = Array.from({ length: 1001 }, (_, index) => ({ id: `qa${index}`, questions: [`Prepared question ${index}`], answer: "Durable answer", createdAt: "2020-01-01", updatedAt: "2020-02-01" }));
  const bank = repository.importBank({ entries, updatedAt: "2020-03-01" }, "replace", undefined, true);
  assert.equal(bank.entries.length, 1001);
  assert.equal(bank.entries[0].updatedAt, "2020-02-01");
  assert.equal(bank.updatedAt, "2020-03-01");
  new KnowledgeRepository(database).replacePack(structuredClone(EMPTY_KNOWLEDGE_PACK));
  assert.equal(repository.readBank().updatedAt, "2020-03-01");
  assert.throws(() => repository.importBank({ entries: [{ questions: [] }] }, "replace"), /required/);
  assert.equal(repository.readBank().entries.length, 1001);
  repository.clearQA();
  assert.equal(database.prepare<[], { count: number }>("SELECT count(*) AS count FROM retrieval_fts WHERE retrieval_fts MATCH 'Durable'").get()!.count, 0);
});

test("promotion requires Good completed interviewee runs and is idempotent", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  database.prepare("INSERT INTO questions(id, primary_ask, mode_snapshot, created_at) VALUES ('q', 'Why SQLite?', 'INTERVIEWEE', '2020')").run();
  database.prepare("INSERT INTO model_requests(id, question_id, purpose, mode_snapshot, created_at) VALUES ('r', 'q', 'ANSWER', 'INTERVIEWEE', '2020')").run();
  database.prepare("INSERT INTO model_runs(id, request_id, slot, status, output_text, started_at) VALUES ('run', 'r', 'SINGLE', 'COMPLETED', 'Atomic transactions', '2020')").run();
  const repository = new AnswerLibraryRepository(database);
  assert.throws(() => repository.promoteRun("run"), /Good/);
  assert.throws(() => repository.upsertQA({ questions: ["Run-linked copy"], answer: "Unrated" }, undefined, { originRunId: "run" }), /Good/);
  assert.equal(database.prepare<[], { count: number }>("SELECT count(*) AS count FROM retrieval_items").get()!.count, 0);
  database.prepare("UPDATE model_runs SET feedback = 'GOOD' WHERE id = 'run'").run();
  assert.equal(repository.promoteRun("run").alreadyExists, false);
  assert.equal(repository.promoteRun("run").alreadyExists, true);
  assert.equal(repository.readBank().entries.length, 1);
  database.prepare("UPDATE knowledge_entries SET enabled = 0 WHERE kind = 'QA'").run();
  assert.throws(() => repository.promoteRun("run"), /enabled and approved/);
  database.prepare("UPDATE model_requests SET mode_snapshot = 'INTERVIEWER' WHERE id = 'r'").run();
  assert.throws(() => repository.promoteRun("run"), /INTERVIEWEE/);
});

test("mode-less promotion is allowed only for explicit migrated prepared links", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  database.prepare("INSERT INTO questions(id, primary_ask, created_at) VALUES ('legacy-q', 'Legacy prepared question', '2020')").run();
  database.prepare("INSERT INTO model_requests(id, question_id, purpose, created_at) VALUES ('legacy-r', 'legacy-q', 'ANSWER', '2020')").run();
  database.prepare("INSERT INTO model_runs(id, request_id, slot, status, feedback, output_text, started_at) VALUES ('legacy', 'legacy-r', 'SINGLE', 'COMPLETED', 'GOOD', 'Prepared answer', '2020')").run();
  const answers = new AnswerLibraryRepository(database);
  assert.throws(() => answers.promoteRun("legacy"), /INTERVIEWEE/);
  assert.throws(() => answers.upsertQA({ id: "linked", questions: ["Legacy prepared question"], answer: "Prepared answer" }, undefined, { originRunId: "legacy" }), /INTERVIEWEE/);
  answers.upsertQA({ id: "linked", questions: ["Legacy prepared question"], answer: "Prepared answer", createdAt: "2020", updatedAt: "2020" }, undefined, { originRunId: "legacy", preserveTimestamps: true });
  assert.deepEqual(answers.promoteRun("legacy").entryId, "linked");
  assert.equal(answers.promoteRun("legacy").alreadyExists, true);
});