import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { SettingsRepository, SettingsConflictError } from "../lib/server/repositories/settingsRepository";

test("settings patches commit atomically, reject secrets, and protect canonical migration values", (context) => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const repo = new SettingsRepository(db);
  repo.upsert({ bg: "canonical" }, { bg: 0 });
  assert.throws(() => repo.upsert({ "meetingCopilot.lastCompany": "Uncommitted", bg: "stale" }, { bg: 0, "meetingCopilot.lastCompany": 0 }), SettingsConflictError);
  assert.equal(repo.get("meetingCopilot.lastCompany"), undefined);
  assert.equal(repo.get("bg")?.value, "canonical");
  assert.throws(() => repo.upsert({ OPENAI_API_KEY: "secret" }), /Unknown setting/);
  repo.upsert({ bg: "updated", "meetingCopilot.captureCandidateMic": true }, { bg: 1, "meetingCopilot.captureCandidateMic": 0 });
  assert.equal(repo.get("bg")?.revision, 2);
  assert.equal(repo.get("meetingCopilot.captureCandidateMic")?.value, true);
  assert.throws(() => repo.upsert({ bg: "unguarded" }), /revision is required/);
  repo.upsert({ "meetingCopilot.modeVariant": "course_admission" }, { "meetingCopilot.modeVariant": 0 });
  assert.equal(repo.get("meetingCopilot.modeVariant")?.value, "course_admission");
});