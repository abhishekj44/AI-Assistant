"use client";

import { useEffect, useState } from "react";
import { DEFAULT_PROMPT_RULES, PROMPT_RULES_VERSION, PROMPT_STYLE_STORAGE_KEY, PROMPT_RULES_VERSION_STORAGE_KEY, PREVIOUS_PROMPT_STYLE_STORAGE_KEY, LEGACY_PROMPT_RULES_BACKUP_KEY } from "./utils";

type Setting = { key: string; value: unknown; revision: number };
const cache = new Map<string, Setting>();
let hydration: Promise<void> | undefined;
let queue = Promise.resolve();
let hydrated = false;
export const SETTINGS_UPDATED_EVENT = "settings-updated";
export const SETTINGS_ERROR_EVENT = "settings-error";
function notify(error?: string) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(error ? SETTINGS_ERROR_EVENT : SETTINGS_UPDATED_EVENT, { detail: error }));
}
function accept(settings: Setting[]) {
  cache.clear();
  for (const setting of settings) cache.set(setting.key, setting);
  notify();
}
async function reload() {
  const response = await fetch("/api/settings", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || !Array.isArray(data.settings)) throw new Error(data.error || "Unable to load settings");
  accept(data.settings);
}
async function commit(patch: Record<string, unknown>, expectedRevisions: Record<string, number>) {
  const response = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ patch, expectedRevisions }) });
  const data = await response.json();
  if (!response.ok || !data.committed) {
    if (response.status === 409) await reload();
    throw new Error(data.error || "Settings save failed");
  }
  accept(data.settings);
}
async function migrate() {
  const keys = ["bg", PROMPT_STYLE_STORAGE_KEY, PROMPT_RULES_VERSION_STORAGE_KEY, PREVIOUS_PROMPT_STYLE_STORAGE_KEY, LEGACY_PROMPT_RULES_BACKUP_KEY, "meetingCopilot.captureCandidateMic", "meetingCopilot.lastCompany", "meetingCopilot.modeVariant"];
  const patch: Record<string, unknown> = {};
  const sources: Array<[string, string]> = [];
  for (const key of keys) {
    const raw = localStorage.getItem(key);
    if (raw === null || cache.has(key)) continue;
    patch[key] = key === "meetingCopilot.captureCandidateMic" ? raw === "true" : key === PROMPT_RULES_VERSION_STORAGE_KEY ? Number(raw) : raw.slice(0, 20000);
    sources.push([key, key]);
  }
  const legacy = localStorage.getItem("custom_prompt_rules");
  if (!cache.has(PROMPT_STYLE_STORAGE_KEY) && !(PROMPT_STYLE_STORAGE_KEY in patch)) {
    const previous = localStorage.getItem(PREVIOUS_PROMPT_STYLE_STORAGE_KEY);
    if (previous || legacy) {
      patch[PROMPT_STYLE_STORAGE_KEY] = (previous || legacy || DEFAULT_PROMPT_RULES).slice(0, 2500);
      if (legacy) sources.push(["custom_prompt_rules", PROMPT_STYLE_STORAGE_KEY]);
    }
  }
  if (PROMPT_STYLE_STORAGE_KEY in patch && !cache.has(PROMPT_RULES_VERSION_STORAGE_KEY)) patch[PROMPT_RULES_VERSION_STORAGE_KEY] = PROMPT_RULES_VERSION;
  if (!Object.keys(patch).length) return;
  try { await commit(patch, Object.fromEntries(Object.keys(patch).map((key) => [key, 0]))); }
  catch { return; }
  for (const [source, target] of sources) if (cache.get(target)?.value === patch[target]) localStorage.removeItem(source);
}
export function hydrateSettings(): Promise<void> {
  if (!hydration) hydration = (async () => {
    try {
      await reload();
      try { await migrate(); } catch { notify("Browser preference migration unavailable"); }
      hydrated = true;
      notify();
    }
    catch (error) { hydration = undefined; notify(error instanceof Error ? error.message : "Settings unavailable"); throw error; }
  })();
  return hydration;
}
export function getSetting<T>(key: string, fallback: T): T { return cache.has(key) ? cache.get(key)!.value as T : fallback; }
export function setSettings(patch: Record<string, unknown>): Promise<void> {
  const operation = queue.then(async () => {
    await hydrateSettings();
    try { await commit(patch, Object.fromEntries(Object.keys(patch).map((key) => [key, cache.get(key)?.revision ?? 0]))); }
    catch (error) { notify(error instanceof Error ? error.message : "Settings save failed"); throw error; }
  });
  queue = operation.catch(() => undefined);
  return operation;
}
export function setSetting(key: string, value: unknown): Promise<void> { return setSettings({ [key]: value }); }
export function useAppSetting<T>(key: string, fallback: T): { value: T; ready: boolean; error: string; setValue: (value: T) => Promise<void> } {
  const [value, updateValue] = useState<T>(() => getSetting(key, fallback));
  const [ready, setReady] = useState(hydrated);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () => { updateValue(getSetting(key, fallback)); setReady(hydrated); };
    const failed = (event: Event) => setError(String((event as CustomEvent).detail || "Settings unavailable"));
    window.addEventListener(SETTINGS_UPDATED_EVENT, refresh);
    window.addEventListener(SETTINGS_ERROR_EVENT, failed);
    void hydrateSettings().then(() => { if (active) refresh(); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Settings unavailable"); });
    return () => { active = false; window.removeEventListener(SETTINGS_UPDATED_EVENT, refresh); window.removeEventListener(SETTINGS_ERROR_EVENT, failed); };
  }, [key, fallback]);
  return { value, ready, error, setValue: async (next) => { setError(""); await setSetting(key, next); } };
}