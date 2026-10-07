import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { SettingsRepository, settingsRepository } from "../lib/server/repositories/settingsRepository";
import { GET, POST } from "../app/api/settings/route";

test("settings HTTP API saves plain patches, later saves replace earlier values, and invalid patches change nothing", async (context) => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const repo = new SettingsRepository(db);
  context.mock.method(settingsRepository, "getAll", repo.getAll.bind(repo));
  context.mock.method(settingsRepository, "upsert", repo.upsert.bind(repo));
  const save = (body: object) => POST(new Request("http://localhost/api/settings", { method: "POST", body: JSON.stringify(body) }));
  assert.equal((await save({ patch: { bg: "First" } })).status, 200);
  assert.equal((await save({ patch: { bg: "Second", "meetingCopilot.lastCompany": "Company" } })).status, 200);
  assert.equal((await save({ patch: { bg: "Rejected", "meetingCopilot.modeVariant": "bogus" } })).status, 400);
  assert.equal((await save({ patch: { OPENAI_API_KEY: "secret" } })).status, 400);
  const data = await (await GET()).json();
  assert.deepEqual(Object.fromEntries(data.settings.map((setting: { key: string; value: unknown }) => [setting.key, setting.value])), { bg: "Second", "meetingCopilot.lastCompany": "Company" });
  assert.ok(data.settings.every((setting: object) => !("revision" in setting)));
});