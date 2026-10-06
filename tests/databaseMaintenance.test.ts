import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { migrateDatabase } from "../lib/server/db/migrations";
import { MaintenanceRepository } from "../lib/server/repositories/maintenanceRepository";
import { GET, POST } from "../app/api/database/route";

test("maintenance API backs up WAL safely, exports, and refuses live restore or arbitrary paths", async context => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maintenance-"));
  const filename = path.join(root, "test.db");
  const database = new Database(filename);
  database.pragma("journal_mode=WAL"); database.pragma("wal_autocheckpoint=0"); database.pragma("foreign_keys=ON"); migrateDatabase(database);
  const previousPath = process.env.COPILOT_DB_PATH;
  const previousCwd = process.cwd();
  const globals = globalThis as typeof globalThis & { copilotDatabases?: Map<string, Database.Database> };
  const connections = globals.copilotDatabases ??= new Map();
  connections.set(filename, database);
  process.env.COPILOT_DB_PATH = filename;
  process.chdir(root);
  context.after(() => {
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.COPILOT_DB_PATH; else process.env.COPILOT_DB_PATH = previousPath;
    connections.delete(filename); database.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  database.prepare("UPDATE profiles SET display_name=?").run("Private profile");
  const repository = new MaintenanceRepository(database, root);
  const handlers = { GET, POST };
  const post = (body: unknown) => handlers.POST(new Request("http://localhost/api/database", { method: "POST", body: JSON.stringify(body) }));
  const stats = await (await handlers.GET(new Request("http://localhost/api/database"))).json();
  assert.equal(stats.healthy, true); assert.equal(stats.counts.profiles, 1); assert.ok(stats.storage.walBytes > 0);
  assert.ok(!JSON.stringify(stats).includes("Private profile"));
  const response = await post({ action: "backup" }); assert.equal(response.status, 200);
  const backup = await response.json();
  const copied = new Database(path.join(root, "data", "backups", backup.id), { readonly: true });
  try { assert.equal((copied.prepare("SELECT display_name FROM profiles").get() as { display_name: string }).display_name, "Private profile"); } finally { copied.close(); }
  database.prepare("UPDATE profiles SET display_name='New live value'").run();
  const restore = await post({ action: "restore", id: backup.id });
  assert.equal(restore.status, 409); assert.equal((await restore.json()).requiresRestart, true);
  assert.equal((database.prepare("SELECT display_name FROM profiles").get() as { display_name: string }).display_name, "New live value");
  const exported = await handlers.GET(new Request(`http://localhost/api/database?backup=${backup.id}`));
  assert.equal(exported.status, 200); assert.equal(Buffer.from(await exported.arrayBuffer()).subarray(0, 15).toString(), "SQLite format 3");
  assert.equal((await post({ action: "restore", id: "../../test.db" })).status, 400);
  assert.equal((await handlers.GET(new Request("http://localhost/api/database?backup=C:/secret.db"))).status, 400);
  assert.equal((await post({ action: "unknown" })).status, 400);
  assert.equal((await handlers.POST(new Request("http://localhost/api/database", { method: "POST", body: "x".repeat(4097) }))).status, 413);
});

test("FTS integrity detects stale external-content index and explicit rebuild repairs it", context => {
  const database = new Database(":memory:"); migrateDatabase(database); context.after(() => database.close());
  database.prepare("INSERT INTO questions(id,primary_ask,created_at) VALUES ('question','SQLite','2024-01-01')").run();
  database.prepare("INSERT INTO retrieval_items(question_id,title,body,content_hash) VALUES ('question','SQLite','transaction wal backup','hash')").run();
  const repository = new MaintenanceRepository(database, os.tmpdir());
  database.exec("INSERT INTO retrieval_fts(retrieval_fts) VALUES ('delete-all')");
  assert.equal(repository.stats().ftsIntegrity, false);
  assert.equal(repository.rebuildSearchIndex().items, 1);
  assert.equal(repository.stats().ftsIntegrity, true);
  assert.equal((database.prepare("SELECT count(*) AS count FROM retrieval_fts WHERE retrieval_fts MATCH 'backup'").get() as { count: number }).count, 1);
});