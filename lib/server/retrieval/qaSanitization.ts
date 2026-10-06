import crypto from "node:crypto";
import type { QAEntry } from "../../qa/types";

export function cleanString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const clean = value.trim();
  if (clean.length > max) throw new Error(`Value exceeds the supported ${max} character limit`);
  return clean;
}

function cleanStrings(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > maxItems) throw new Error(`List exceeds the supported ${maxItems} item limit`);
  const result = new Map<string, string>();
  for (const item of value) {
    const clean = cleanString(item, maxChars);
    if (clean) result.set(clean.toLowerCase(), clean);
  }
  return [...result.values()];
}

export function sanitizeQAEntry(value: unknown, existing?: QAEntry): QAEntry {
  if (!value || typeof value !== "object") throw new Error("Q&A entry must be an object");
  const raw = value as Record<string, unknown>;
  const questions = cleanStrings(raw.questions, 12, 500);
  const answer = cleanString(raw.answer, 4_000);
  if (!questions.length) throw new Error("At least one prepared question is required");
  if (!answer) throw new Error("A prepared answer is required");
  const priority = Number(raw.priority);
  const now = new Date().toISOString();
  return {
    id: existing?.id || cleanString(raw.id, 120) || crypto.randomUUID(),
    category: cleanString(raw.category, 120) || undefined,
    questions, answer,
    keyPoints: cleanStrings(raw.keyPoints, 16, 400),
    tags: cleanStrings(raw.tags, 20, 100),
    personal: raw.personal === true,
    priority: Number.isFinite(priority) ? Math.round(Math.max(0, Math.min(priority, 10))) : 5,
    enabled: raw.enabled !== false,
    createdAt: existing?.createdAt || cleanString(raw.createdAt, 80) || now,
    updatedAt: now,
  };
}