import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import type { MeetingMemory, SpeakerRole, TranscriptTurn } from "@/lib/conversationTypes";

export const runtime = "nodejs";
const SESSIONS_DIR = path.join(process.cwd(), "sessions");
const MAX_TURNS_PER_SESSION = 5_000;

function safeSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const safe = value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
  return safe || null;
}

function strings(value: unknown, max = 50): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, max)
    : [];
}

function sanitizeTurn(value: unknown, index: number): TranscriptTurn | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const text = typeof candidate.text === "string" ? candidate.text.trim().slice(0, 5_000) : "";
  if (!text) return null;

  const speaker: SpeakerRole = candidate.speaker === "me" ? "me" : "interviewer";
  return {
    id: typeof candidate.id === "string" ? candidate.id.slice(0, 160) : `saved_turn_${index}`,
    sequenceId: Number.isFinite(candidate.sequenceId) ? Number(candidate.sequenceId) : index,
    speaker,
    text,
    timestamp: typeof candidate.timestamp === "string" ? candidate.timestamp : new Date().toISOString(),
    audioStart: Number.isFinite(candidate.audioStart) ? Number(candidate.audioStart) : undefined,
    audioEnd: Number.isFinite(candidate.audioEnd) ? Number(candidate.audioEnd) : undefined,
    confidence: Number.isFinite(candidate.confidence) ? Number(candidate.confidence) : undefined,
    isInterim: false,
  };
}

function sanitizeMemory(value: any): MeetingMemory {
  return {
    summary: typeof value?.summary === "string" ? value.summary.slice(0, 4_000) : "",
    currentTopic: typeof value?.currentTopic === "string" ? value.currentTopic.slice(0, 300) : undefined,
    facts: strings(value?.facts),
    decisions: strings(value?.decisions),
    openQuestions: strings(value?.openQuestions),
    entities: strings(value?.entities),
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : undefined,
  };
}

export async function POST(req: Request) {
  try {
    const session = await req.json();
    const id = safeSessionId(session?.id);
    if (!id || !Array.isArray(session?.transcripts)) {
      return NextResponse.json({ error: "Invalid session data" }, { status: 400 });
    }

    const rawTranscripts: unknown[] = session.transcripts.slice(-MAX_TURNS_PER_SESSION);
    const transcripts = rawTranscripts
      .map((turn, index) => sanitizeTurn(turn, index))
      .filter((turn): turn is TranscriptTurn => turn !== null);

    const rawInfo = session?.sessionInfo;
    const sessionInfo = rawInfo && typeof rawInfo === "object"
      ? {
          company: typeof rawInfo.company === "string" ? rawInfo.company.trim().slice(0, 200) : "",
          callType: ["interview", "meeting", "screen", "other"].includes(rawInfo.callType) ? rawInfo.callType : "interview",
          details: typeof rawInfo.details === "string" ? rawInfo.details.trim().slice(0, 1_000) : "",
        }
      : undefined;

    const safeSession = {
      id,
      startedAt: typeof session?.startedAt === "string" ? session.startedAt : new Date().toISOString(),
      endedAt: typeof session?.endedAt === "string" ? session.endedAt : new Date().toISOString(),
      transcripts,
      memory: sanitizeMemory(session?.memory),
      ...(sessionInfo ? { sessionInfo } : {}),
    };

    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${id}_${timestamp}.json`;
    await fs.writeFile(path.join(SESSIONS_DIR, filename), JSON.stringify(safeSession, null, 2), "utf8");
    return NextResponse.json({ success: true, filename });
  } catch (error) {
    console.error("Session persistence failed", error);
    return NextResponse.json({ error: "Failed to save session" }, { status: 500 });
  }
}

export async function GET() {
  try {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    const files = (await fs.readdir(SESSIONS_DIR))
      .filter((file) => file.endsWith(".json"))
      .sort()
      .slice(-100)
      .reverse();
    const sessions = [];
    for (const file of files) {
      try {
        sessions.push(JSON.parse(await fs.readFile(path.join(SESSIONS_DIR, file), "utf8")));
      } catch {
        // Corrupt files are isolated and do not break history loading.
      }
    }
    return NextResponse.json({ sessions });
  } catch (error) {
    console.error("Session read failed", error);
    return NextResponse.json({ error: "Failed to read sessions" }, { status: 500 });
  }
}
