import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { migrateDatabase, LOCAL_PROFILE_ID } from "../lib/server/db/migrations";

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
  assert.equal(database.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM profiles").get()!.count, 1);
  assert.throws(() => database.prepare("DELETE FROM profiles WHERE id = ?").run(LOCAL_PROFILE_ID), /FOREIGN KEY/);
  assert.throws(() => database.transaction(() => {
    database.prepare("UPDATE profiles SET display_name = 'Changed' WHERE id = ?").run(LOCAL_PROFILE_ID);
    throw new Error("rollback");
  })(), /rollback/);
  assert.equal(database.prepare<[string], { display_name: string }>("SELECT display_name FROM profiles WHERE id = ?").get(LOCAL_PROFILE_ID)!.display_name, "Me");
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
  database.prepare("INSERT INTO sessions(id, local_profile_id, mode, started_at) VALUES (?, ?, ?, ?)")
    .run("session", LOCAL_PROFILE_ID, "INTERVIEWEE", now);
  assert.throws(() => database.prepare("INSERT INTO sessions(id, local_profile_id, mode, started_at) VALUES (?, ?, ?, ?)")
    .run("bad", LOCAL_PROFILE_ID, "interview", now), /CHECK/);
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