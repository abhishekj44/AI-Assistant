import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { KnowledgeRepository } from "../lib/server/repositories/knowledgeRepository";
import { AnswerLibraryRepository } from "../lib/server/repositories/answerLibraryRepository";
import { RetrievalRepository } from "../lib/server/repositories/retrievalRepository";
import { EMPTY_KNOWLEDGE_PACK } from "../lib/knowledge/types";
import { createRetrievalService } from "../lib/server/retrieval/service";
import { selectQAMatches } from "../lib/qa/qaSelector";
import { selectCandidateContextWithMeta } from "../lib/knowledge/contextSelector";
import { splitSearchChunks } from "../lib/server/retrieval/indexing";
import { SessionRepository } from "../lib/server/repositories/sessionRepository";
import { QuestionRepository } from "../lib/server/repositories/questionRepository";

test("FTS normalizes technical aliases and safely handles spoken syntax", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  new KnowledgeRepository(database).replacePack({ ...structuredClone(EMPTY_KNOWLEDGE_PACK), facts: ["C++ C# .NET Node.js retrieval augmented generation fine-tuning", "日本語の経験"] });
  const repository = new RetrievalRepository(database);
  for (const query of ["cpp", "csharp", "dotnet", "nodejs", "RAG", "fine tuning", "日本語の経験"]) assert.ok(repository.retrieve(query).length, query);
  assert.deepEqual(repository.retrieve('" OR * NOT nonexistingxyz'), []);
  assert.deepEqual(repository.retrieve("the and how"), []);
  const first = repository.retrieve("cpp");
  assert.deepEqual(repository.retrieve("cpp"), first);
  assert.ok(first[0].rank < 0);
  assert.equal(first[0].sourceKind, "ENTRY");
  new KnowledgeRepository(database).replacePack({ ...structuredClone(EMPTY_KNOWLEDGE_PACK), facts: ["C++ C# .NET Node.js retrieval augmented generation fine-tuning", "New entry"] });
  assert.equal(repository.retrieve("cpp")[0].id, first[0].id);
});

test("review and base filtering happen before limit and history is opt-in", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const answers = new AnswerLibraryRepository(database);
  answers.upsertQA({ id: "disabled", questions: ["SQLite SQLite SQLite"], answer: "SQLite", enabled: false });
  answers.upsertQA({ id: "approved", questions: ["SQLite transactions"], answer: "Durable commits" });
  const retrieval = new RetrievalRepository(database);
  assert.equal(retrieval.retrieve("SQLite", { limit: 1 })[0].provenance.qaId, "approved");
  database.prepare("UPDATE knowledge_entries SET review_state = 'REJECTED' WHERE enabled = 1").run();
  assert.deepEqual(retrieval.retrieve("SQLite"), []);
  database.prepare("INSERT INTO profiles(id, kind, display_name, created_at, updated_at) VALUES ('other', 'CONTACT', 'Other', '2020', '2020')").run();
  database.prepare("INSERT INTO knowledge_bases(id, profile_id, kind, name, created_at, updated_at) VALUES ('other-base', 'other', 'PERSONAL', 'Other', '2020', '2020')").run();
  new KnowledgeRepository(database).replacePack({ ...structuredClone(EMPTY_KNOWLEDGE_PACK), facts: ["Other person SQLite"] }, "other-base");
  assert.deepEqual(retrieval.retrieve("SQLite", { baseIds: ["other-base"] }), []);
  database.prepare("INSERT INTO sessions(id, local_profile_id, mode, started_at) VALUES ('s', 'local-user', 'INTERVIEWEE', '2020')").run();
  database.prepare("INSERT INTO questions(id, session_id, primary_ask, created_at) VALUES ('q', 's', 'SQLite?', '2020')").run();
  database.prepare("INSERT INTO retrieval_items(question_id, title, body, content_hash) VALUES ('q', 'SQLite history', 'SQLite history', 'hash')").run();
  assert.deepEqual(retrieval.retrieve("SQLite", { sourceKinds: ["QUESTION"] }), []);
  assert.equal(retrieval.retrieve("SQLite", { sessionId: "s", sourceKinds: ["QUESTION"] }).length, 1);
  assert.deepEqual(retrieval.retrieve("SQLite", { sessionId: "missing" }), []);
});

test("context service retains personal fallback, follow-ups, aliases and revision refresh", async (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const knowledge = new KnowledgeRepository(database);
  knowledge.replacePack({ ...structuredClone(EMPTY_KNOWLEDGE_PACK), profile: { headline: "Engineer", strengths: ["Systems"] }, facts: ["Personal baseline"] });
  const answers = new AnswerLibraryRepository(database);
  answers.upsertQA({ id: "cpp", questions: ["Why C++?"], answer: "Native systems", tags: ["C++"] });
  const retrieve = createRetrievalService(database);
  const aliases = await retrieve("cpp", "");
  assert.equal(aliases.bank.entries[0].id, "cpp");
  assert.ok(selectQAMatches(aliases.bank, "cpp").length);
  const followUp = await retrieve("why that approach", "We discussed C++ native systems");
  assert.ok(followUp.bank.entries.length);
  assert.equal((await retrieve("Tell me about yourself", "")).pack.profile.headline, "Engineer");
  knowledge.replacePack({ ...structuredClone(EMPTY_KNOWLEDGE_PACK), facts: ["New baseline"] });
  assert.deepEqual((await retrieve("unknownterm", "")).pack.facts, ["New baseline"]);
  assert.deepEqual((await retrieve("cpp", "", { baseIds: [] })).bank.entries, []);
});

test("session-linked bases replace default scope and other profiles stay excluded", async (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  database.prepare("INSERT INTO knowledge_bases(id, profile_id, kind, name, created_at, updated_at) VALUES ('linked', 'local-user', 'PERSONAL', 'Linked', '2020', '2020')").run();
  database.prepare("INSERT INTO sessions(id, local_profile_id, mode, started_at) VALUES ('session', 'local-user', 'MEETING', '2020')").run();
  database.prepare("INSERT INTO session_knowledge_bases(session_id, knowledge_base_id, usage_role) VALUES ('session', 'linked', 'PERSONAL_FACTS')").run();
  const knowledge = new KnowledgeRepository(database);
  knowledge.replacePack({ ...structuredClone(EMPTY_KNOWLEDGE_PACK), facts: ["Default baseline"] });
  knowledge.replacePack({ ...structuredClone(EMPTY_KNOWLEDGE_PACK), facts: ["Linked baseline"] }, "linked");
  const retrieve = createRetrievalService(database);
  assert.deepEqual((await retrieve("baseline", "", { sessionId: "session" })).pack.facts, ["Linked baseline"]);
  assert.deepEqual((await retrieve("baseline", "", { sessionId: "session", baseIds: ["personal-knowledge"] })).pack.facts, []);
  assert.deepEqual((await retrieve("baseline", "")).pack.facts, ["Default baseline"]);
  assert.deepEqual((await retrieve("baseline", "", { sessionId: "unknown" })).pack.facts, []);
});

test("alias shortlists preserve source-supported examples through existing scorers", async (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const knowledge = new KnowledgeRepository(database);
  knowledge.replacePack({ ...structuredClone(EMPTY_KNOWLEDGE_PACK), projects: [{ name: "Engine", technologies: ["C++"], decisions: [], challenges: [], metrics: [], lessons: [], examples: [{ title: "Native pipeline", approach: "C++ workers", result: "Lower latency" }] }] });
  const answers = new AnswerLibraryRepository(database);
  answers.upsertQA({ id: "canonical", questions: ["Why cpp?"], answer: "Native code" });
  const retrieve = createRetrievalService(database);
  const response = await retrieve("How did you design cpp workers?", "");
  const selected = selectCandidateContextWithMeta(response.pack, "How did you design cpp workers?", "");
  assert.ok(selected.selectedProjectNames.includes("Engine"));
  assert.ok(selected.projectExampleIncluded);
  const reverse = await retrieve("C++", "");
  assert.ok(selectQAMatches(reverse.bank, "C++").length);
  assert.deepEqual(knowledge.getPack().projects[0].answerHooks, undefined);
});

test("sentence-aware chunks retain overlap and session history is explicitly scoped", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const text = "SQLite uses short transactions. ".repeat(150);
  const chunks = splitSearchChunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 1600));
  assert.ok(chunks[0].slice(-100).includes("transactions"));
  const sessions = new SessionRepository(database);
  sessions.start({ id: "scope", ownerTabId: "tab", sessionInfo: { callType: "meeting", company: "", details: "" } });
  sessions.appendTurns("scope", [{ id: "turn", sequenceId: 1, speaker: "interviewer", text: "Discuss checkpointing", timestamp: new Date().toISOString() }], "tab");
  sessions.updateSummary("scope", "We discussed checkpointing", 1);
  new QuestionRepository(database).create({ sessionId: "scope", question: "What is checkpointing?" });
  const retrieval = new RetrievalRepository(database);
  assert.deepEqual(retrieval.retrieve("checkpointing"), []);
  const history = retrieval.retrieve("checkpointing", { sessionId: "scope", sourceKinds: ["QUESTION", "SUMMARY", "TRANSCRIPT"] });
  assert.equal(history.length, 3);
  assert.deepEqual(retrieval.retrieve("checkpointing", { sessionId: "other", sourceKinds: ["TRANSCRIPT"] }), []);
});