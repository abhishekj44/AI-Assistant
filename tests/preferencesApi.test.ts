import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { SettingsRepository, settingsRepository } from "../lib/server/repositories/settingsRepository";
import { GET, POST } from "../app/api/settings/route";

test("settings HTTP API requires revisions and rejects stale patches atomically", async (context) => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const repo = new SettingsRepository(db);
  context.mock.method(settingsRepository, "getAll", repo.getAll.bind(repo));
  context.mock.method(settingsRepository, "upsert", repo.upsert.bind(repo));
  const save = (body: object) => POST(new Request("http://localhost/api/settings", { method: "POST", body: JSON.stringify(body) }));
  assert.equal((await save({ patch: { bg: "Missing revision" } })).status, 400);
  assert.equal((await save({ patch: { bg: "Canonical" }, expectedRevisions: { bg: 0 } })).status, 200);
  assert.equal((await save({ patch: { bg: "Stale", "meetingCopilot.lastCompany": "Not committed" }, expectedRevisions: { bg: 0, "meetingCopilot.lastCompany": 0 } })).status, 409);
  const data = await (await GET()).json();
  assert.equal(data.settings.length, 1);
  assert.equal(data.settings[0].value, "Canonical");
});