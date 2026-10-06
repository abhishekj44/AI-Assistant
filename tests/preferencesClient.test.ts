import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { SettingsRepository, SettingsConflictError } from "../lib/server/repositories/settingsRepository";
import { PROMPT_STYLE_STORAGE_KEY } from "../lib/utils";

test("client hydrates canonical defaults, clears only acknowledged migrations and rejects stale saves", async (context) => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const repo = new SettingsRepository(db);
  repo.upsert({ bg: "DB default" }, { bg: 0 });
  const browser = new Map([["bg", "old browser"], ["meetingCopilot.captureCandidateMic", "true"], ["custom_prompt_rules", "custom style"], ["unrelated", "keep"]]);
  const storage = { getItem: (key: string) => browser.get(key) ?? null, removeItem: (key: string) => { browser.delete(key); } };
  context.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    if (!options?.method) return Response.json({ settings: repo.getAll() });
    const body = JSON.parse(String(options.body));
    try { return Response.json({ committed: true, settings: repo.upsert(body.patch, body.expectedRevisions) }); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "failed" }, { status: error instanceof SettingsConflictError ? 409 : 400 }); }
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  context.after(() => { Reflect.deleteProperty(globalThis, "localStorage"); });
  const { hydrateSettings, getSetting, setSetting } = await import("../lib/clientSettings");
  await hydrateSettings();
  assert.equal(getSetting("bg", ""), "DB default");
  assert.equal(getSetting("meetingCopilot.captureCandidateMic", false), true);
  assert.equal(getSetting(PROMPT_STYLE_STORAGE_KEY, ""), "custom style");
  assert.equal(browser.get("bg"), "old browser");
  assert.equal(browser.get("unrelated"), "keep");
  assert.equal(browser.has("custom_prompt_rules"), false);
  assert.equal(browser.has("meetingCopilot.captureCandidateMic"), false);
  repo.upsert({ bg: "newer tab" }, { bg: 1 });
  await assert.rejects(setSetting("bg", "stale tab"), /Setting changed/);
  assert.equal(getSetting("bg", ""), "newer tab");
  assert.equal(repo.get("bg")?.value, "newer tab");
});