import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { EMPTY_QA_BANK, type QABank, type QAEntry } from "@/lib/qa/types";

const DATA_DIR = path.join(process.cwd(), "data");
const QA_PATH = path.join(DATA_DIR, "qa-bank.json");
const MAX_ENTRIES = 1_000;

let cachedBank: QABank | null = null;
let cachedMtimeMs = -1;

function cleanString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanStrings(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    const cleaned = cleanString(item, maxChars);
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= maxItems) break;
  }
  return result;
}

function clampPriority(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(Math.max(0, Math.min(parsed, 10))) : 5;
}

export function sanitizeQAEntry(value: unknown, existing?: QAEntry): QAEntry {
  if (!value || typeof value !== "object") throw new Error("Q&A entry must be an object");
  const raw = value as Record<string, unknown>;
  const questions = cleanStrings(raw.questions, 12, 500);
  const answer = cleanString(raw.answer, 4_000);
  if (questions.length === 0) throw new Error("At least one prepared question is required");
  if (!answer) throw new Error("A prepared answer is required");

  const now = new Date().toISOString();
  return {
    id: existing?.id || cleanString(raw.id, 120) || crypto.randomUUID(),
    category: cleanString(raw.category, 120) || undefined,
    questions,
    answer,
    keyPoints: cleanStrings(raw.keyPoints, 16, 400),
    tags: cleanStrings(raw.tags, 20, 100),
    personal: raw.personal === true,
    priority: clampPriority(raw.priority),
    enabled: raw.enabled !== false,
    createdAt: existing?.createdAt || cleanString(raw.createdAt, 80) || now,
    updatedAt: now,
  };
}

function sanitizeBank(value: unknown): QABank {
  if (!value || typeof value !== "object") return { ...EMPTY_QA_BANK };
  const raw = value as Record<string, unknown>;
  const entriesRaw = Array.isArray(raw.entries) ? raw.entries.slice(0, MAX_ENTRIES) : [];
  const entries: QAEntry[] = [];
  const ids = new Set<string>();

  for (const item of entriesRaw) {
    try {
      const entry = sanitizeQAEntry(item);
      if (ids.has(entry.id)) entry.id = crypto.randomUUID();
      ids.add(entry.id);
      entries.push(entry);
    } catch {
      // Invalid imported entries are isolated instead of making the whole bank unusable.
    }
  }

  return {
    version: 1,
    updatedAt: cleanString(raw.updatedAt, 80) || new Date().toISOString(),
    entries,
  };
}

export interface QABankReadResult {
  bank: QABank;
  cacheHit: boolean;
}

export async function readQABankWithMeta(): Promise<QABankReadResult> {
  try {
    const stat = await fs.stat(QA_PATH);
    if (cachedBank && cachedMtimeMs === stat.mtimeMs) return { bank: cachedBank, cacheHit: true };

    const raw = await fs.readFile(QA_PATH, "utf8");
    const bank = sanitizeBank(JSON.parse(raw));
    cachedBank = bank;
    cachedMtimeMs = stat.mtimeMs;
    return { bank, cacheHit: false };
  } catch (error: any) {
    if (error?.code !== "ENOENT") console.warn("[qa-bank] failed to read bank, using empty bank:", error?.message);
    const empty = { ...EMPTY_QA_BANK, updatedAt: new Date(0).toISOString(), entries: [] };
    cachedBank = empty;
    cachedMtimeMs = -1;
    return { bank: empty, cacheHit: false };
  }
}

export async function readQABank(): Promise<QABank> {
  return (await readQABankWithMeta()).bank;
}

async function writeQABank(bank: QABank): Promise<QABank> {
  if (bank.entries.length > MAX_ENTRIES) throw new Error(`Q&A bank cannot exceed ${MAX_ENTRIES} entries`);
  const next: QABank = { version: 1, updatedAt: new Date().toISOString(), entries: bank.entries };
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempPath = `${QA_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tempPath, QA_PATH);
  const stat = await fs.stat(QA_PATH);
  cachedBank = next;
  cachedMtimeMs = stat.mtimeMs;
  return next;
}

export async function upsertQAEntry(value: unknown): Promise<QABank> {
  const bank = await readQABank();
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const requestedId = cleanString(raw.id, 120);
  const index = requestedId ? bank.entries.findIndex((entry) => entry.id === requestedId) : -1;
  const entry = sanitizeQAEntry(value, index >= 0 ? bank.entries[index] : undefined);

  const normalizedFirst = entry.questions[0].toLowerCase();
  const duplicateIndex = bank.entries.findIndex(
    (existing, i) => i !== index && existing.questions.some((question) => question.toLowerCase() === normalizedFirst),
  );
  if (duplicateIndex >= 0) throw new Error("A Q&A entry with the same primary question already exists");

  const entries = [...bank.entries];
  if (index >= 0) entries[index] = entry;
  else entries.unshift(entry);
  return writeQABank({ ...bank, entries: entries.slice(0, MAX_ENTRIES) });
}

export async function deleteQAEntry(id: string): Promise<QABank> {
  const bank = await readQABank();
  const entries = bank.entries.filter((entry) => entry.id !== id);
  if (entries.length === bank.entries.length) throw new Error("Q&A entry not found");
  return writeQABank({ ...bank, entries });
}

export async function clearQABank(): Promise<QABank> {
  return writeQABank({ version: 1, updatedAt: new Date().toISOString(), entries: [] });
}

export async function importQABank(value: unknown, mode: "merge" | "replace" = "merge"): Promise<QABank> {
  const imported = sanitizeBank(value);
  if (imported.entries.length === 0) throw new Error("Imported Q&A bank contains no valid entries");
  const current = mode === "replace" ? { ...EMPTY_QA_BANK, entries: [] } : await readQABank();
  const map = new Map<string, QAEntry>();

  for (const entry of current.entries) map.set(entry.id, entry);
  for (const entry of imported.entries) {
    const duplicate = Array.from(map.values()).find((existing) =>
      existing.questions.some((question) => entry.questions.some((candidate) => candidate.toLowerCase() === question.toLowerCase())),
    );
    map.set(duplicate?.id || entry.id, duplicate ? { ...entry, id: duplicate.id, createdAt: duplicate.createdAt } : entry);
  }

  return writeQABank({ version: 1, updatedAt: new Date().toISOString(), entries: Array.from(map.values()).slice(0, MAX_ENTRIES) });
}
