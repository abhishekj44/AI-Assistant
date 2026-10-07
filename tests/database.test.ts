import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { openDatabase, getDatabase } from "../lib/server/db/connection";
import { migrateDatabase, DEFAULT_KNOWLEDGE_BASE_ID } from "../lib/server/db/migrations";
import { SessionRepository } from "../lib/server/repositories/sessionRepository";

test("SQLite foundation enforces WAL, foreign keys, transactions and FTS5", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-db-"));
  const database = openDatabase(path.join(directory, "test.db"));
  context.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(database.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(database.pragma("synchronous", { simple: true }), 2);
  migrateDatabase(database);
  assert.equal(database.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM knowledge_bases").get()!.count, 1);
  assert.throws(() => database.prepare("INSERT INTO session_knowledge_bases(session_id, knowledge_base_id) VALUES ('missing', ?)").run(DEFAULT_KNOWLEDGE_BASE_ID), /FOREIGN KEY/);
  assert.throws(() => database.transaction(() => {
    database.prepare("UPDATE knowledge_bases SET name = 'Changed' WHERE id = ?").run(DEFAULT_KNOWLEDGE_BASE_ID);
    throw new Error("rollback");
  })(), /rollback/);
  assert.equal(database.prepare<[string], { name: string }>("SELECT name FROM knowledge_bases WHERE id = ?").get(DEFAULT_KNOWLEDGE_BASE_ID)!.name, "Candidate Knowledge");
  database.exec("CREATE VIRTUAL TABLE temp.search_test USING fts5(content)");
  database.prepare("INSERT INTO temp.search_test(content) VALUES (?)").run("SQLite interview retrieval");
  assert.equal(database.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM temp.search_test WHERE search_test MATCH ?").get("retrieval")!.count, 1);
  const version = (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
  const [major, minor, patch] = version.split(".").map(Number);
  assert.ok(major > 3 || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3))), `SQLite ${version} must include the WAL-reset fix`);
});

test("application constraints and cascading FTS deletion stay consistent", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const now = new Date().toISOString();
  database.prepare("INSERT INTO sessions(id, mode, started_at) VALUES (?, ?, ?)")
    .run("session", "INTERVIEWEE", now);
  assert.throws(() => database.prepare("INSERT INTO sessions(id, mode, started_at) VALUES (?, ?, ?)")
    .run("bad", "interview", now), /CHECK/);
  const insertTurn = database.prepare("INSERT INTO transcript_turns(id, session_id, client_turn_id, sequence_no, speaker, text, captured_at, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insertTurn.run("turn", "session", "client-turn", 1, "REMOTE", "What is SQLite?", now, now);
  assert.throws(() => insertTurn.run("duplicate", "session", "client-turn", 2, "REMOTE", "Again", now, now), /UNIQUE/);
  database.prepare("INSERT INTO retrieval_items(transcript_turn_id, title, body, content_hash) VALUES (?, ?, ?, ?)")
    .run("turn", "Question", "SQLite transaction rollback", "hash");
  assert.equal(database.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM retrieval_fts WHERE retrieval_fts MATCH 'rollback'").get()!.count, 1);
  database.prepare("DELETE FROM sessions WHERE id = ?").run("session");
  assert.equal(database.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM retrieval_fts WHERE retrieval_fts MATCH 'rollback'").get()!.count, 0);
  database.exec("INSERT INTO retrieval_fts(retrieval_fts, rank) VALUES ('integrity-check', 1)");
});

test("role metadata migration preserves populated version-one sessions on reopen", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-role-upgrade-"));
  const filename = path.join(directory, "test.db");
  let database = openDatabase(filename);
  context.after(() => {
    if (database.open) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const sessions = new SessionRepository(database);
  sessions.start({ id: "existing", ownerTabId: "tab", sessionInfo: { company: "Example", details: "Architecture round",
    callType: "giving_interview", jobDescription: "Build reliable queues" } });
  sessions.appendTurns("existing", [{ id: "turn", sequenceId: 1, speaker: "interviewer", text: "How do retries work?", timestamp: new Date().toISOString() }], "tab");
  sessions.end("existing", "tab");
  sessions.updateSummary("existing", "Discussed safe retries", 1);
  const initialMigration = database.prepare("SELECT * FROM schema_migrations WHERE version=1").get();
  database.exec("ALTER TABLE sessions DROP COLUMN job_title; ALTER TABLE sessions DROP COLUMN seniority; DELETE FROM schema_migrations WHERE version=2");
  database.close();

  database = openDatabase(filename);
  const restored = new SessionRepository(database).get("existing")!;
  assert.equal(restored.status, "ENDED");
  assert.equal(restored.sessionInfo!.jobDescription, "Build reliable queues");
  assert.equal(restored.sessionInfo!.details, "Architecture round");
  assert.equal(restored.sessionInfo!.jobTitle, undefined);
  assert.equal(restored.sessionInfo!.seniority, undefined);
  assert.equal(restored.transcripts[0].text, "How do retries work?");
  assert.equal(restored.summary, "Discussed safe retries");
  assert.equal(restored.summaryStatus, "READY");
  assert.deepEqual(database.prepare("SELECT * FROM schema_migrations WHERE version=1").get(), initialMigration);
  assert.deepEqual(database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    [{ version: 1, name: "initial_schema" }, { version: 2, name: "giving_interview_role" }]);
  assert.equal(database.pragma("integrity_check", { simple: true }), "ok");
  database.exec("INSERT INTO retrieval_fts(retrieval_fts, rank) VALUES ('integrity-check', 1)");
  const next = new SessionRepository(database).start({ id: "next", ownerTabId: "tab", sessionInfo: { company: "", details: "",
    callType: "giving_interview", jobTitle: "Backend Engineer", jobDescription: "Reliable storage", seniority: "Senior" } });
  assert.equal(next.sessionInfo!.jobTitle, "Backend Engineer");
  assert.equal(next.sessionInfo!.seniority, "Senior");
});

test("a database from an earlier schema is refused untouched with move-aside guidance", (context) => {
  const database = new Database(":memory:");
  context.after(() => database.close());
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  database.prepare("INSERT INTO schema_migrations VALUES (1, 'profiles_and_knowledge_bases', 'earlier-checksum', 'now')").run();
  database.prepare("INSERT INTO schema_migrations VALUES (4, 'role_specific_interview_context', 'earlier-checksum', 'now')").run();
  assert.throws(() => migrateDatabase(database), /cannot be upgraded in place.*-wal and -shm/);
  assert.equal((database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'sessions'").get() as { count: number }).count, 0);
});

test("reopening the app database frees summaries left pending by a stopped app", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-recovery-"));
  const filename = path.join(directory, "test.db");
  const first = openDatabase(filename);
  const sessions = new SessionRepository(first);
  sessions.start({ id: "session", ownerTabId: "tab" });
  sessions.appendTurns("session", [{ id: "turn", sequenceId: 1, speaker: "me", text: "Hello", timestamp: new Date().toISOString() }], "tab");
  sessions.end("session", "tab");
  assert.equal(sessions.claimSummary("session"), 1);
  first.close();
  const previous = { path: process.env.COPILOT_DB_PATH, root: process.env.COPILOT_LEGACY_ROOT };
  const connections = (globalThis as typeof globalThis & { copilotDatabases?: Map<string, Database.Database> }).copilotDatabases ??= new Map();
  process.env.COPILOT_DB_PATH = filename;
  process.env.COPILOT_LEGACY_ROOT = path.join(directory, "none");
  const reopened = getDatabase();
  context.after(() => {
    connections.delete(path.resolve(filename));
    reopened.close();
    if (previous.path === undefined) delete process.env.COPILOT_DB_PATH; else process.env.COPILOT_DB_PATH = previous.path;
    if (previous.root === undefined) delete process.env.COPILOT_LEGACY_ROOT; else process.env.COPILOT_LEGACY_ROOT = previous.root;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const restored = new SessionRepository(reopened).get("session")!;
  assert.equal(restored.summaryStatus, "FAILED");
  assert.match(restored.summaryError!, /stopped before/);
  assert.equal(new SessionRepository(reopened).claimSummary("session", true), 1);
});

test("migrating again changes nothing and a newer application's database is rejected", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const before = database.prepare("SELECT version, name, checksum FROM schema_migrations").all();
  migrateDatabase(database);
  assert.deepEqual(database.prepare("SELECT version, name, checksum FROM schema_migrations").all(), before);
  assert.equal((database.prepare("SELECT count(*) AS count FROM knowledge_bases").get() as { count: number }).count, 1);
  database.prepare("INSERT INTO schema_migrations VALUES (99, 'future', 'checksum', 'now')").run();
  assert.throws(() => migrateDatabase(database), /newer application version/);
});