import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
const QA_FILE = path.join(process.cwd(), "data", "qa-history.json");
const MAX_ENTRIES = 500;

interface QAEntry {
  id: string;
  createdAt: string;
  question: string;
  answer: string;
  tag: string;
  sessionId?: string;
}

async function readEntries(): Promise<QAEntry[]> {
  try {
    const raw = await fs.readFile(QA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeEntries(entries: QAEntry[]) {
  await fs.mkdir(path.dirname(QA_FILE), { recursive: true });
  await fs.writeFile(QA_FILE, JSON.stringify(entries, null, 2), "utf8");
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const question = typeof body?.question === "string" ? body.question.trim().slice(0, 5_000) : "";
    const answer = typeof body?.answer === "string" ? body.answer.trim().slice(0, 10_000) : "";
    const tag = typeof body?.tag === "string" ? body.tag.trim().slice(0, 100) : "AI Mode";
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId.slice(0, 100) : undefined;

    if (!answer) {
      return NextResponse.json({ error: "Answer is required" }, { status: 400 });
    }

    const entry: QAEntry = {
      id: `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      question,
      answer,
      tag,
      ...(sessionId ? { sessionId } : {}),
    };

    const entries = await readEntries();
    entries.unshift(entry);
    await writeEntries(entries.slice(0, MAX_ENTRIES));

    return NextResponse.json({ success: true, id: entry.id });
  } catch (error) {
    console.error("Q&A history save failed", error);
    return NextResponse.json({ error: "Failed to save Q&A entry" }, { status: 500 });
  }
}

export async function GET() {
  try {
    const entries = await readEntries();
    return NextResponse.json({ entries });
  } catch (error) {
    console.error("Q&A history read failed", error);
    return NextResponse.json({ error: "Failed to read Q&A history" }, { status: 500 });
  }
}
