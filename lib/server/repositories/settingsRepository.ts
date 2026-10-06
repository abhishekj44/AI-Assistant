import type Database from "better-sqlite3";
import { getDatabase } from "../db/connection";

export const SETTING_KEYS = ["bg", "meetingCopilot.promptStyle.v10", "meetingCopilot.promptRulesVersion", "meetingCopilot.legacyPromptRules.v9", "meetingCopilot.promptStyle.v9", "meetingCopilot.captureCandidateMic", "meetingCopilot.lastCompany", "meetingCopilot.modeVariant"] as const;
export interface Setting { key: string; value: unknown; revision: number; updated_at: string }
export class SettingsConflictError extends Error {}

export class SettingsRepository {
  constructor(private readonly database?: Database.Database) {}
  private get db() { return this.database ?? getDatabase(); }
  getAll(): Setting[] {
    return (this.db.prepare("SELECT * FROM app_settings ORDER BY key").all() as Array<{ key: string; value_json: string; revision: number; updated_at: string }>).map(({ value_json, ...row }) => ({ ...row, value: JSON.parse(value_json) }));
  }
  get(key: string): Setting | undefined { return this.getAll().find((row) => row.key === key); }
  seedDocument(key: "courseInterviewGuide", text: string): string {
    this.db.prepare("INSERT OR IGNORE INTO app_settings(key,value_json,updated_at) VALUES (?,?,?)").run(key, JSON.stringify(text), new Date().toISOString());
    return this.get(key)?.value as string || "";
  }
  upsert(patch: Record<string, unknown>, expectedRevisions: Record<string, number> = {}): Setting[] {
    if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) throw new Error("A settings patch is required");
    for (const [key, value] of Object.entries(patch)) {
      if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown setting: ${key}`);
      if (key === "meetingCopilot.captureCandidateMic" ? typeof value !== "boolean" : key === "meetingCopilot.promptRulesVersion" ? !Number.isSafeInteger(value) || Number(value) < 0 : typeof value !== "string" || value.length > 20000) throw new Error(`Invalid setting: ${key}`);
      const expected = expectedRevisions[key];
      if (!Number.isSafeInteger(expected) || expected < 0) throw new Error("Expected revision is required");
      if (key === "meetingCopilot.modeVariant" && !["standard", "course_admission"].includes(String(value))) throw new Error("Invalid mode variant");
    }
    const db = this.db;
    return db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        const current = db.prepare("SELECT revision FROM app_settings WHERE key = ?").get(key) as { revision: number } | undefined;
        if (expectedRevisions[key] !== undefined && expectedRevisions[key] !== (current?.revision ?? 0)) throw new SettingsConflictError(`Setting changed: ${key}`);
        db.prepare("INSERT INTO app_settings(key,value_json,revision,updated_at) VALUES (?,?,1,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, revision=app_settings.revision+1, updated_at=excluded.updated_at").run(key, JSON.stringify(value), new Date().toISOString());
      }
      return this.getAll();
    })();
  }
}
export const settingsRepository = new SettingsRepository();