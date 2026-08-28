import crypto from "node:crypto";
import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { readQABank, upsertQAEntry } from "@/lib/server/qaStore";
import { normalizeCallType, type CallType } from "@/lib/callTypes";

export const runtime = "nodejs";
const QA_FILE = path.join(process.cwd(), "data", "qa-history.json");
const MAX_ENTRIES = 500;

type QAFeedback = "good" | "poor";
interface QAHistoryEntry {
  id: string;
  createdAt: string;
  question: string;
  scenarioContext?: string;
  retrievalQuery?: string;
  answer: string;
  tag: string;
  sessionId?: string;
  callType: CallType;
  feedback?: QAFeedback;
  feedbackAt?: string;
  promotedAt?: string;
  promotedQaEntryId?: string;
}

let mutationQueue: Promise<unknown> = Promise.resolve();
const clean = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

function sanitizeEntry(value: unknown): QAHistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = clean(raw.id, 160);
  const answer = clean(raw.answer, 10_000);
  if (!id || !answer) return null;
  const feedback: QAFeedback | undefined = raw.feedback === "good" || raw.feedback === "poor" ? raw.feedback : undefined;
  return {
    id,
    createdAt: clean(raw.createdAt, 80) || new Date().toISOString(),
    question: clean(raw.question, 5_000),
    scenarioContext: clean(raw.scenarioContext, 3_000) || undefined,
    retrievalQuery: clean(raw.retrievalQuery, 1_200) || undefined,
    answer,
    tag: clean(raw.tag, 100) || "AI Mode",
    sessionId: clean(raw.sessionId, 120) || undefined,
    callType: raw.callType == null ? "giving_interview" : normalizeCallType(raw.callType),
    feedback,
    feedbackAt: clean(raw.feedbackAt, 80) || undefined,
    promotedAt: clean(raw.promotedAt, 80) || undefined,
    promotedQaEntryId: clean(raw.promotedQaEntryId, 160) || undefined,
  };
}

async function readEntries(): Promise<QAHistoryEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(QA_FILE, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitizeEntry).filter((entry): entry is QAHistoryEntry => Boolean(entry)).slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

async function writeEntries(entries: QAHistoryEntry[]) {
  await fs.mkdir(path.dirname(QA_FILE), { recursive: true });
  const temp = `${QA_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2), "utf8");
  await fs.rename(temp, QA_FILE);
}

async function mutateEntries<T>(mutator: (entries: QAHistoryEntry[]) => Promise<T> | T): Promise<T> {
  const task = mutationQueue.then(async () => {
    const entries = await readEntries();
    const result = await mutator(entries);
    await writeEntries(entries);
    return result;
  });
  mutationQueue = task.then(() => undefined, () => undefined);
  return task;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const answer = clean(body?.answer, 10_000);
    if (!answer) return NextResponse.json({ error: "Answer is required" }, { status: 400 });
    const entry: QAHistoryEntry = {
      id: `qa_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      question: clean(body?.question, 5_000),
      scenarioContext: clean(body?.scenarioContext, 3_000) || undefined,
      retrievalQuery: clean(body?.retrievalQuery, 1_200) || undefined,
      answer,
      tag: clean(body?.tag, 100) || "AI Mode",
      sessionId: clean(body?.sessionId, 120) || undefined,
      callType: normalizeCallType(body?.callType),
    };
    await mutateEntries((entries) => { entries.unshift(entry); });
    return NextResponse.json({ success: true, id: entry.id });
  } catch (error) {
    console.error("Q&A history save failed", error);
    return NextResponse.json({ error: "Failed to save Q&A entry" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    const id = clean(body?.id, 160);
    const feedback: QAFeedback | null = body?.feedback === "good" || body?.feedback === "poor" ? body.feedback : null;
    if (!id || !feedback) return NextResponse.json({ error: "id and feedback=good|poor are required" }, { status: 400 });
    await mutateEntries((entries) => {
      const entry = entries.find((item) => item.id === id);
      if (!entry) throw new Error("Q&A history entry not found");
      if (entry.promotedAt && feedback === "poor") throw new Error("A promoted answer cannot be marked poor until it is removed from Prepared Q&A");
      entry.feedback = feedback;
      entry.feedbackAt = new Date().toISOString();
    });
    return NextResponse.json({ success: true, feedback });
  } catch (error: any) {
    const message = error?.message || "Failed to update Q&A feedback";
    return NextResponse.json({ error: message }, { status: /not found/i.test(message) ? 404 : /promoted/i.test(message) ? 409 : 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json();
    const id = clean(body?.id, 160);
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    const entries = await readEntries();
    const entry = entries.find((item) => item.id === id);
    if (!entry) return NextResponse.json({ error: "Q&A history entry not found" }, { status: 404 });
    if (entry.promotedAt && entry.promotedQaEntryId) {
      return NextResponse.json({ success: true, qaEntryId: entry.promotedQaEntryId, alreadyExists: true, alreadyPromoted: true });
    }
    if (entry.callType !== "giving_interview") return NextResponse.json({ error: "Only Giving Interview answers can be promoted to the candidate Q&A bank" }, { status: 409 });
    if (!entry.question) return NextResponse.json({ error: "Only generated answers with a question can be promoted" }, { status: 400 });
    if (entry.feedback !== "good") return NextResponse.json({ error: "Mark the answer Good before promoting it" }, { status: 409 });

    const bank = await readQABank();
    const normalized = entry.question.toLowerCase();
    const existing = bank.entries.find((candidate) => candidate.questions.some((question) => question.toLowerCase() === normalized));
    let qaEntryId = existing?.id;
    let alreadyExists = Boolean(existing);
    if (!existing) {
      const questions = [entry.question];
      const updated = await upsertQAEntry({
        category: "approved-history",
        questions,
        answer: entry.answer,
        keyPoints: [],
        tags: ["approved", "interview-history"],
        personal: true,
        priority: 8,
        enabled: true,
      });
      qaEntryId = updated.entries.find((candidate) => candidate.questions.some((question) => question.toLowerCase() === normalized))?.id;
      alreadyExists = false;
    }
    await mutateEntries((current) => {
      const target = current.find((item) => item.id === id);
      if (!target) return;
      target.promotedAt = new Date().toISOString();
      target.promotedQaEntryId = qaEntryId;
    });
    return NextResponse.json({ success: true, qaEntryId, alreadyExists });
  } catch (error: any) {
    console.error("Q&A history promotion failed", error);
    return NextResponse.json({ error: error?.message || "Failed to promote Q&A entry" }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const requested = Number(new URL(req.url).searchParams.get("limit") || 50);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(Math.round(requested), 100)) : 50;
    return NextResponse.json({ entries: (await readEntries()).slice(0, limit) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Q&A history read failed", error);
    return NextResponse.json({ error: "Failed to read Q&A history" }, { status: 500 });
  }
}
