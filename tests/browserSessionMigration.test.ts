import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { BrowserImportRepository } from "../lib/server/repositories/browserImportRepository";
import { SessionRepository } from "../lib/server/repositories/sessionRepository";
import { migrateBrowserSessions } from "../lib/browserSessionMigration";

test("old browser sessions migrate idempotently and only clear after acknowledgement", async (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new BrowserImportRepository(database);
  const sessions = [{ id: "legacy", startedAt: "2021-01-02T10:00:00.000Z", endedAt: "2021-01-02T11:00:00.000Z", summary: "Interview summary",
    transcripts: [{ speaker: "external", text: "Why SQLite?", timestamp: "10:30:00" }] }];
  const values = new Map([["interview_sessions_v3", JSON.stringify(sessions)], ["interview_active_session_id_v3", "legacy"]]);
  const storage = { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => { values.delete(key); } };
  await assert.rejects(migrateBrowserSessions(storage, async () => ({ committed: false, sessionIds: [] })), /acknowledged/);
  assert.ok(values.has("interview_sessions_v3"));
  const ids = repository.importSessions(sessions, "http://localhost:3000");
  assert.deepEqual(repository.importSessions(sessions, "http://localhost:3000"), ids);
  const restored = new SessionRepository(database).get("legacy")!;
  assert.equal(restored.transcripts.length, 1);
  assert.equal(restored.transcripts[0].speaker, "interviewer");
  assert.equal(restored.memory.summary, "Interview summary");
  await migrateBrowserSessions(storage, async () => ({ committed: true, sessionIds: ids }));
  assert.equal(values.size, 0);
});