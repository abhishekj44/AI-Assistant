import { after, NextResponse } from "next/server";
import { sessionRepository, SessionPersistenceError } from "@/lib/server/repositories/sessionRepository";
import { KnowledgeBaseError, knowledgeBaseRepository } from "@/lib/server/repositories/knowledgeBaseRepository";
import { processSessionJobs } from "@/lib/server/sessionJobs";
import type { MeetingMemory, SessionInfo, TranscriptTurn } from "@/lib/conversationTypes";
import { DEFAULT_KNOWLEDGE_BASE_ID } from "@/lib/server/db/migrations";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function invalid(message: string): never { throw new SessionPersistenceError(message, 400); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Expected object");
  return value as Record<string, unknown>;
}
function string(value: unknown, maximum: number, required = true): string {
  if (typeof value !== "string" || value.length > maximum || (required && !value.trim())) invalid("Invalid string field");
  return value;
}
function id(value: unknown): string {
  const result = string(value, 160);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) invalid("Invalid id");
  return result;
}
function date(value: unknown): string {
  const result = string(value, 64);
  if (!Number.isFinite(Date.parse(result))) invalid("Invalid timestamp");
  return new Date(result).toISOString();
}
function info(value: unknown): SessionInfo | undefined {
  if (value === undefined) return undefined;
  const candidate = object(value);
  if (!["taking_interview", "giving_interview", "meeting"].includes(String(candidate.callType))) invalid("Invalid session mode");
  if (candidate.modeVariant !== undefined && !["standard", "course_admission"].includes(String(candidate.modeVariant))) invalid("Invalid variant");
  const knowledgeBaseIds = candidate.callType === "giving_interview" ? [DEFAULT_KNOWLEDGE_BASE_ID]
    : candidate.callType === "taking_interview" ? [] : candidate.knowledgeBaseIds === undefined ? undefined
      : knowledgeBaseRepository.validateSelections(candidate.knowledgeBaseIds, "MEETING").map(base => base.id);
  const jobDescription = candidate.jobDescription === undefined ? undefined : string(candidate.jobDescription, 12_000, false).trim();
  const candidateProfile = candidate.candidateProfile === undefined ? undefined : string(candidate.candidateProfile, 12_000, false).trim();
  return { company: string(candidate.company, 200, false), details: string(candidate.details, 2000, false), callType: candidate.callType as SessionInfo["callType"], modeVariant: candidate.modeVariant as SessionInfo["modeVariant"], knowledgeBaseIds,
    jobDescription: candidate.callType === "giving_interview" ? jobDescription : undefined,
    candidateProfile: candidate.callType === "taking_interview" ? candidateProfile : undefined };
}
function turns(value: unknown, maximum = 128): TranscriptTurn[] {
  if (!Array.isArray(value) || value.length > maximum) invalid("Invalid turns batch");
  return value.map(raw => {
    const candidate = object(raw);
    if (!["me", "interviewer"].includes(String(candidate.speaker)) || candidate.isInterim === true) invalid("Expected finalized turn");
    if (!Number.isSafeInteger(candidate.sequenceId)) invalid("Invalid client sequence");
    for (const field of ["audioStart", "audioEnd", "confidence"] as const) {
      if (candidate[field] !== undefined && (typeof candidate[field] !== "number" || !Number.isFinite(candidate[field]))) invalid(`Invalid ${field}`);
    }
    if (typeof candidate.confidence === "number" && (candidate.confidence < 0 || candidate.confidence > 1)) invalid("Invalid confidence");
    return { id: id(candidate.id), sequenceId: candidate.sequenceId as number, speaker: candidate.speaker as TranscriptTurn["speaker"], text: string(candidate.text, 20_000).trim(), timestamp: date(candidate.timestamp), audioStart: candidate.audioStart as number | undefined, audioEnd: candidate.audioEnd as number | undefined, confidence: candidate.confidence as number | undefined, isInterim: false };
  });
}
function memory(value: unknown): MeetingMemory {
  const candidate = object(value);
  const result: MeetingMemory = { summary: string(candidate.summary, 32_000, false), facts: [], decisions: [], openQuestions: [], entities: [] };
  for (const field of ["facts", "decisions", "openQuestions", "entities"] as const) {
    if (!Array.isArray(candidate[field]) || candidate[field].length > 200) invalid(`Invalid memory ${field}`);
    result[field] = (candidate[field] as unknown[]).map(item => string(item, 4000));
  }
  if (candidate.currentTopic !== undefined) result.currentTopic = string(candidate.currentTopic, 1000, false);
  if (candidate.updatedAt !== undefined) result.updatedAt = date(candidate.updatedAt);
  return result;
}
function errorResponse(error: unknown) {
  if (error instanceof SessionPersistenceError || error instanceof KnowledgeBaseError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error("Session persistence failed", error);
  return NextResponse.json({ error: "Session persistence unavailable" }, { status: 500 });
}
function resumeJobs() { after(async () => { await processSessionJobs(); }); }

export async function GET(req: Request) {
  try {
    const parameters = new URL(req.url).searchParams;
    let result;
    if (parameters.has("id")) result = { session: parameters.get("active") === "1" ? sessionRepository.restoreActive(id(parameters.get("id"))) : sessionRepository.get(id(parameters.get("id"))) };
    else if (parameters.get("active") === "1") result = { session: sessionRepository.restoreActive() };
    else {
      const limit = parameters.has("limit") ? Number(parameters.get("limit")) : 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid("Invalid limit");
      const cursor = parameters.get("cursor") ?? undefined;
      if (cursor && cursor.length > 240) invalid("Invalid cursor");
      const sessions = sessionRepository.list({ limit, cursor, includeTranscripts: parameters.get("transcripts") === "1" });
      const last = sessions.at(-1);
      result = { sessions, nextCursor: sessions.length === limit && last ? `${last.startedAt}|${last.id}` : null };
    }
    resumeJobs();
    return NextResponse.json(result);
  } catch (error) { return errorResponse(error); }
}

export async function POST(req: Request) {
  try {
    if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) throw new SessionPersistenceError("Session request too large", 413);
    const reader = req.body?.getReader();
    if (!reader) invalid("Missing request body");
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new SessionPersistenceError("Session request too large", 413); }
      chunks.push(chunk.value);
    }
    let body: Record<string, unknown>;
    try { body = object(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { invalid("Invalid JSON body"); }
    const sessionId = id(body.id);
    const ownerTabId = id(body.ownerTabId);
    const action = body.action ?? "snapshot";
    let session;
    switch (action) {
      case "start":
        if (body.takeover !== undefined && typeof body.takeover !== "boolean") invalid("Invalid takeover flag");
        session = sessionRepository.start({ id: sessionId, ownerTabId, sessionInfo: info(body.sessionInfo), startedAt: body.startedAt === undefined ? undefined : date(body.startedAt), takeover: body.takeover as boolean | undefined });
        break;
      case "append": session = sessionRepository.appendTurns(sessionId, turns(body.turns), ownerTabId); break;
      case "end": session = sessionRepository.end(sessionId, ownerTabId, turns(body.turns ?? []), body.endedAt === undefined ? undefined : date(body.endedAt)); break;
      case "memory":
        if (!Number.isSafeInteger(body.coveredThroughSequence)) invalid("Invalid memory coverage");
        session = sessionRepository.updateMemory(sessionId, memory(body.memory), body.coveredThroughSequence as number, ownerTabId);
        break;
      case "snapshot": session = sessionRepository.saveSnapshot({ id: sessionId, startedAt: date(body.startedAt), endedAt: body.endedAt === undefined ? undefined : date(body.endedAt), sessionInfo: info(body.sessionInfo), transcripts: turns(body.transcripts, 50_000), memory: memory(body.memory) }, ownerTabId); break;
      default: invalid("Unknown session action; owner-free imports must use the storage importer");
    }
    resumeJobs();
    return NextResponse.json({ success: true, session: { ...session, transcripts: undefined }, committedThroughSequence: session.throughSequence });
  } catch (error) { return errorResponse(error); }
}
