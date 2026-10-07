import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { SettingsRepository } from "../lib/server/repositories/settingsRepository";
import { PROMPT_STYLE_STORAGE_KEY } from "../lib/utils";

test("client hydrates canonical defaults, clears only acknowledged migrations and saves plain values", async (context) => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const repo = new SettingsRepository(db);
  repo.upsert({ bg: "DB default" });
  const browser = new Map([["bg", "old browser"], ["meetingCopilot.captureCandidateMic", "true"], ["custom_prompt_rules", "custom style"], ["unrelated", "keep"]]);
  const storage = { getItem: (key: string) => browser.get(key) ?? null, removeItem: (key: string) => { browser.delete(key); } };
  context.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    if (!options?.method) return Response.json({ settings: repo.getAll() });
    const body = JSON.parse(String(options.body));
    try { return Response.json({ committed: true, settings: repo.upsert(body.patch) }); }
    catch (error) { return Response.json({ error: error instanceof Error ? error.message : "failed" }, { status: 400 }); }
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
  await setSetting("bg", "client value");
  assert.equal(getSetting("bg", ""), "client value");
  assert.equal(repo.get("bg")?.value, "client value");
  await assert.rejects(setSetting("meetingCopilot.modeVariant", "bogus"), /Invalid mode variant/);
  assert.equal(getSetting("meetingCopilot.modeVariant", "standard"), "standard");
});