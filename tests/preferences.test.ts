import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { SettingsRepository } from "../lib/server/repositories/settingsRepository";

test("settings patches save plain values, reject secrets and invalid values, and never half-apply", (context) => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const repo = new SettingsRepository(db);
  repo.upsert({ bg: "first" });
  assert.throws(() => repo.upsert({ "meetingCopilot.lastCompany": "Uncommitted", OPENAI_API_KEY: "secret" }), /Unknown setting/);
  assert.throws(() => repo.upsert({ bg: "Not saved", "meetingCopilot.modeVariant": "bogus" }), /Invalid mode variant/);
  assert.equal(repo.get("meetingCopilot.lastCompany"), undefined);
  assert.equal(repo.get("bg")?.value, "first");
  assert.throws(() => repo.upsert({ "meetingCopilot.captureCandidateMic": "yes" }), /Invalid setting/);
  assert.throws(() => repo.upsert({}), /patch is required/);
  repo.upsert({ bg: "updated", "meetingCopilot.captureCandidateMic": true });
  assert.equal(repo.get("bg")?.value, "updated");
  assert.equal(repo.get("meetingCopilot.captureCandidateMic")?.value, true);
  assert.ok(repo.getAll().every((setting) => !("revision" in setting)));
  repo.upsert({ "meetingCopilot.modeVariant": "course_admission" });
  assert.equal(repo.get("meetingCopilot.modeVariant")?.value, "course_admission");
});