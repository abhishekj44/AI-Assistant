import assert from "node:assert/strict";
import test from "node:test";

test("failed migration leaves browser keys intact and defaults wait for hydration", async (context) => {
  const browser = new Map([["bg", "Browser notes"], ["unrelated", "Keep"]]);
  let gets = 0;
  let posts = 0;
  const saved: Record<string, unknown>[] = [];
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => browser.get(key) ?? null, removeItem: (key: string) => { browser.delete(key); } } });
  context.after(() => { Reflect.deleteProperty(globalThis, "localStorage"); });
  context.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
    if (!options?.method) { gets++; return Response.json({ settings: [] }); }
    assert.ok(gets > 0);
    const body = JSON.parse(String(options.body));
    posts++;
    if (posts === 1) return Response.json({ error: "Offline" }, { status: 503 });
    for (const [key, value] of Object.entries(body.patch)) saved.push({ key, value, revision: 1 });
    return Response.json({ committed: true, settings: saved });
  });
  const { setSetting } = await import("../lib/clientSettings");
  await setSetting("meetingCopilot.lastCompany", "Company");
  assert.equal(browser.get("bg"), "Browser notes");
  assert.equal(browser.get("unrelated"), "Keep");
  assert.equal(saved[0].key, "meetingCopilot.lastCompany");
  assert.equal(saved.some((item) => item.key === "bg"), false);
});