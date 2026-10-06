import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { EMPTY_MEETING_MEMORY, type SessionInfo } from "../../conversationTypes";
import { EMPTY_KNOWLEDGE_PACK, type CandidateKnowledgePack } from "../../knowledge/types";
import { DEFAULT_KNOWLEDGE_BASE_ID } from "./migrations";
import { KnowledgeRepository } from "../repositories/knowledgeRepository";
import { AnswerLibraryRepository } from "../repositories/answerLibraryRepository";
import { ModelRunRepository } from "../repositories/modelRunRepository";
import { SessionRepository, type SessionSnapshot } from "../repositories/sessionRepository";
import { indexContent } from "../retrieval/indexing";
import { normalizeSearch } from "../retrieval/normalization";

export const LEGACY_IMPORTER_VERSION = 1;
export const LEGACY_IMPORT_STATUS_KEY = "legacy-file-import-status";
const ORIGIN = `legacy-files:v${LEGACY_IMPORTER_VERSION}`;
export interface LegacyImportResult {
  sourceKey: string;
  status: "COMPLETE" | "SKIPPED" | "ERROR";
  count: number;
  warnings: string[];
  error?: string;
}
export interface LegacyMigrationReport { importerVersion: number; checkedAt: string; sources: LegacyImportResult[] }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Missing or invalid ${field}`);
  return value;
}
function timestamp(value: unknown, field: string): string {
  const result = text(value, field);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Invalid ${field}`);
  return result;
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`Invalid ${field}`);
  return value as string[];
}
function hash(value: string | Buffer): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function callType(value: unknown): SessionInfo["callType"] {
  if (value === undefined || ["interview", "screen", "giving_interview", "INTERVIEWEE"].includes(String(value))) return "giving_interview";
  if (value === "taking_interview" || value === "INTERVIEWER") return "taking_interview";
  if (value === "meeting" || value === "MEETING") return "meeting";
  throw new Error("Invalid legacy session mode");
}

export function normalizeLegacySession(value: unknown): SessionSnapshot {
  const raw = object(value);
  const id = text(raw.id, "session id");
  const info = raw.sessionInfo === undefined ? {} : object(raw.sessionInfo);
  const variant = info.modeVariant ?? raw.modeVariant ?? "standard";
  if (variant !== "standard" && variant !== "course_admission") throw new Error("Invalid legacy session variant");
  if (!Array.isArray(raw.transcripts)) throw new Error("Invalid session transcripts");
  const ids = new Set<string>();
  const transcripts = raw.transcripts.map((value, index) => {
    const turn = object(value);
    const turnText = text(turn.text, "transcript text");
    let capturedAt: string;
    try { capturedAt = timestamp(turn.timestamp, "transcript timestamp"); }
    catch {
      const time = typeof turn.timestamp === "string" ? turn.timestamp.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i) : null;
      if (!time) throw new Error("Invalid transcript timestamp");
      const started = new Date(timestamp(raw.startedAt, "session startedAt"));
      let hours = Number(time[1]);
      if (time[4]) hours = hours % 12 + (time[4].toUpperCase() === "PM" ? 12 : 0);
      if (hours > 23 || Number(time[2]) > 59 || Number(time[3] || 0) > 59) throw new Error("Invalid transcript timestamp");
      started.setHours(hours, Number(time[2]), Number(time[3] || 0), 0);
      if (started.getTime() < Date.parse(String(raw.startedAt)) - 12 * 60 * 60 * 1000) started.setDate(started.getDate() + 1);
      capturedAt = started.toISOString();
    }
    const speaker = String(turn.speaker).toLowerCase();
    const local = ["me", "local", "you", "user", "candidate", "self"].includes(speaker);
    if (!local && !["interviewer", "external", "remote", "system", "other", "assistant"].includes(speaker)) throw new Error("Unknown legacy transcript speaker");
    if (turn.isInterim === true) throw new Error("Interim transcripts cannot be imported as finalized turns");
    const turnId = turn.id === undefined ? `legacy-${hash(JSON.stringify([id, turnText, capturedAt, index]))}` : text(turn.id, "turn id");
    if (ids.has(turnId)) throw new Error("Duplicate legacy transcript id");
    ids.add(turnId);
    for (const field of ["audioStart", "audioEnd", "confidence"] as const) {
      if (turn[field] !== undefined && (typeof turn[field] !== "number" || !Number.isFinite(turn[field]))) throw new Error(`Invalid ${field}`);
    }
    if (typeof turn.confidence === "number" && (turn.confidence < 0 || turn.confidence > 1)) throw new Error("Invalid confidence");
    if (turn.sequenceId !== undefined && (!Number.isSafeInteger(turn.sequenceId) || Number(turn.sequenceId) < 1)) throw new Error("Invalid legacy turn sequence");
    return { id: turnId, sequenceId: Number(turn.sequenceId ?? index + 1), text: turnText, timestamp: capturedAt,
      speaker: local ? "me" as const : "interviewer" as const, audioStart: turn.audioStart as number | undefined,
      audioEnd: turn.audioEnd as number | undefined, confidence: turn.confidence as number | undefined, isInterim: false };
  });
  const memory = raw.memory === undefined ? { ...structuredClone(EMPTY_MEETING_MEMORY), summary: typeof raw.summary === "string" ? raw.summary : "" } : object(raw.memory);
  if (typeof memory.summary !== "string") throw new Error("Invalid memory summary");
  for (const field of ["facts", "decisions", "openQuestions", "entities"] as const) strings(memory[field], `memory ${field}`);
  if (raw.summary !== undefined && typeof raw.summary !== "string") throw new Error("Invalid session summary");
  for (const field of ["company", "details"] as const) if (info[field] !== undefined && typeof info[field] !== "string") throw new Error(`Invalid session ${field}`);
  return { id, startedAt: timestamp(raw.startedAt, "session startedAt"), endedAt: raw.endedAt === undefined ? undefined : timestamp(raw.endedAt, "session endedAt"),
    sessionInfo: { company: String(info.company ?? ""), details: String(info.details ?? ""), callType: callType(info.callType ?? raw.callType ?? raw.mode), modeVariant: variant },
    transcripts, memory: memory as unknown as SessionSnapshot["memory"], summary: raw.summary as string | undefined };
}

function importSession(database: Database.Database, value: unknown): number {
  const snapshot = normalizeLegacySession(value);
  const repository = new SessionRepository(database);
  const existing = repository.get(snapshot.id);
  if (existing?.ownerTabId) throw new Error("Session id is live-owned; import will not overwrite it");
  for (const turn of snapshot.transcripts) {
    const duplicate = existing?.transcripts.find(saved => saved.id === turn.id);
    if (duplicate && (duplicate.text.trim() !== turn.text.trim() || duplicate.speaker !== turn.speaker)) throw new Error("Legacy session snapshots disagree about a turn");
  }
  repository.importSnapshot({ ...snapshot, endedAt: undefined });
  const raw = object(value);
  const update = database.prepare("UPDATE transcript_turns SET text=?, metadata_json=? WHERE session_id=? AND client_turn_id=?");
  snapshot.transcripts.forEach((turn, index) => update.run(turn.text, JSON.stringify({ sequenceId: turn.sequenceId, legacy: raw.transcripts && (raw.transcripts as unknown[])[index] }), snapshot.id, turn.id));
  if (!existing || Date.parse(snapshot.endedAt || snapshot.startedAt) >= Date.parse(existing.endedAt || existing.startedAt)) {
    database.prepare("UPDATE sessions SET memory_json=?,memory_through_sequence=next_sequence WHERE id=?")
      .run(JSON.stringify(snapshot.memory), snapshot.id);
  }
  if (snapshot.endedAt) database.prepare("UPDATE sessions SET status='ENDED', ended_at=? WHERE id=?").run(snapshot.endedAt, snapshot.id);
  return 1;
}

function importKnowledge(database: Database.Database, value: unknown): number {
  const raw = object(value);
  timestamp(raw.updatedAt, "knowledge updatedAt");
  for (const field of ["experience", "projects", "skills", "achievements", "facts", "sources"] as const) {
    if (raw[field] !== undefined && !Array.isArray(raw[field])) throw new Error(`Invalid knowledge ${field}`);
  }
  if (raw.profile !== undefined) object(raw.profile);
  const pack = { ...structuredClone(EMPTY_KNOWLEDGE_PACK), ...raw } as CandidateKnowledgePack;
  for (const field of ["skills", "achievements", "facts"] as const) strings(pack[field], `knowledge ${field}`);
  if (pack.profile.strengths !== undefined) strings(pack.profile.strengths, "profile strengths");
  for (const experience of pack.experience) {
    object(experience);
    for (const field of ["responsibilities", "achievements", "technologies"] as const) strings(experience[field], `experience ${field}`);
  }
  for (const project of pack.projects) {
    object(project); text(project.name, "project name");
    for (const field of ["technologies", "metrics", "lessons"] as const) strings(project[field], `project ${field}`);
    for (const field of ["decisions", "challenges"] as const) if (!Array.isArray(project[field]) || project[field].some(item => !item || typeof item !== "object")) throw new Error(`Invalid project ${field}`);
  }
  const ids = new Set<string>();
  for (const source of pack.sources) {
    object(source);
    if (ids.has(text(source.id, "source id"))) throw new Error("Duplicate knowledge source id");
    ids.add(source.id);
    text(source.filename, "source filename");
    timestamp(source.uploadedAt, "source uploadedAt");
    if (!["resume", "job_description", "project", "notes", "other"].includes(source.type)) throw new Error("Invalid knowledge source type");
    if (typeof source.summary !== "string") throw new Error("Invalid source summary");
    strings(source.facts, "source facts"); strings(source.keywords, "source keywords");
  }
  const repository = new KnowledgeRepository(database);
  if (repository.hasData()) throw new Error("Knowledge already exists; import will not replace it");
  repository.replacePack(pack, undefined, true);
  return pack.sources.length;
}

function importBank(database: Database.Database, value: unknown): number {
  const raw = object(value);
  timestamp(raw.updatedAt, "Q&A updatedAt");
  if (!Array.isArray(raw.entries)) throw new Error("Invalid Q&A entries");
  const ids = new Set<string>();
  const entries = raw.entries.map(value => {
    const entry = object(value);
    const id = text(entry.id, "Q&A id");
    if (ids.has(id)) throw new Error("Duplicate Q&A id");
    ids.add(id);
    const questions = strings(entry.questions, "Q&A questions");
    if (!questions.length || questions.some(question => !question.trim())) throw new Error("Invalid prepared question");
    text(entry.answer, "Q&A answer");
    timestamp(entry.createdAt, "Q&A createdAt");
    timestamp(entry.updatedAt, "Q&A updatedAt");
    strings(entry.keyPoints ?? [], "Q&A keyPoints");
    strings(entry.tags ?? [], "Q&A tags");
    if (entry.priority !== undefined && (!Number.isInteger(entry.priority) || Number(entry.priority) < 0 || Number(entry.priority) > 10)) throw new Error("Invalid Q&A priority");
    for (const field of ["enabled", "personal"] as const) if (entry[field] !== undefined && typeof entry[field] !== "boolean") throw new Error(`Invalid Q&A ${field}`);
    return entry;
  });
  if (database.prepare("SELECT 1 FROM knowledge_entries WHERE kind='QA' AND knowledge_base_id=? LIMIT 1").get(DEFAULT_KNOWLEDGE_BASE_ID)) throw new Error("Prepared Q&A already exists; import will not replace it");
  new AnswerLibraryRepository(database).importBank({ ...raw, entries: entries.map((entry, index) => ({ ...entry, id: `legacy-${hash(String(entry.id))}`, questions: [`Legacy import ${index}`], answer: "Legacy import", keyPoints: [], tags: [] })) }, "merge", undefined, true);
  const update = database.prepare("UPDATE knowledge_entries SET id=?,title=?, question=?, content=?, data_json=?, tags_json=?,created_at=?,updated_at=? WHERE id=?");
  const insert = database.prepare("INSERT INTO knowledge_variants(id,entry_id,alternate_question,normalized_question,position) VALUES (?,?,?,?,?)");
  for (const entry of entries) {
    const id = `qa:${JSON.stringify([DEFAULT_KNOWLEDGE_BASE_ID, entry.id])}`;
    const stagedId = `qa:${JSON.stringify([DEFAULT_KNOWLEDGE_BASE_ID, `legacy-${hash(String(entry.id))}`])}`;
    const questions = entry.questions as string[];
    database.prepare("DELETE FROM knowledge_variants WHERE entry_id=?").run(stagedId);
    database.prepare("DELETE FROM retrieval_items WHERE entry_id=?").run(stagedId);
    update.run(id, questions[0], questions[0], entry.answer, JSON.stringify(entry), JSON.stringify(entry.tags ?? []), entry.createdAt, entry.updatedAt, stagedId);
    const seen = new Set<string>();
    questions.forEach((question, position) => {
      const normalized = normalizeSearch(question);
      if (!seen.has(normalized)) insert.run(`${id}:${position}`, id, question, normalized, position);
      seen.add(normalized);
    });
    indexContent(database, "entry_id", id, questions[0], [...questions, entry.answer, ...(entry.keyPoints as string[] ?? []), ...(entry.tags as string[] ?? [])].join("\n"));
  }
  return entries.length;
}

function importHistory(database: Database.Database, value: unknown, warnings: string[]): number {
  if (!Array.isArray(value)) throw new Error("Legacy answer history must be an array");
  const entries = value.map((value): Record<string, unknown> & { callType: SessionInfo["callType"] } => {
    const entry = object(value);
    text(entry.id, "history id"); text(entry.answer, "history answer"); timestamp(entry.createdAt, "history createdAt");
    return { ...entry, callType: callType(entry.callType ?? entry.mode) };
  });
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(String(entry.id)) || database.prepare("SELECT 1 FROM model_runs WHERE id=?").get(entry.id)) throw new Error("History id already exists");
    ids.add(String(entry.id));
  }
  const count = new ModelRunRepository(database).importHistory(entries);
  for (const entry of entries) {
    const variant = entry.modeVariant ?? entry.variant ?? "standard";
    if (!["standard", "course_admission"].includes(String(variant))) throw new Error("Invalid history variant");
    database.prepare("UPDATE model_requests SET variant_snapshot=?,context_snapshot_json=? WHERE id=?").run(variant, JSON.stringify({ legacy: value[entries.indexOf(entry)] }), `legacy-request:${entry.id}`);
    database.prepare("UPDATE model_runs SET provider=?,model=?,slot=?,metrics_json=?,finished_at=?,saved_at=? WHERE id=?")
      .run(entry.provider ?? null, entry.model ?? null, entry.slot ?? "SINGLE", JSON.stringify(entry.metrics ?? {}), entry.finishedAt ?? entry.createdAt, entry.savedAt ?? entry.createdAt, entry.id);
    if (entry.sessionId && !database.prepare("SELECT 1 FROM sessions WHERE id=?").get(entry.sessionId)) warnings.push("A history session reference was unavailable; original retained in request context");
    if (entry.promotedQaEntryId) {
      const linked = database.prepare("SELECT id FROM knowledge_entries WHERE kind='QA' AND json_extract(data_json,'$.id')=? AND origin_run_id=?").get(entry.promotedQaEntryId, entry.id) as { id: string } | undefined;
      if (!linked) warnings.push("A prepared Q&A promotion could not be linked; original retained in request context");
      else if (entry.callType !== "giving_interview") {
        database.prepare("UPDATE knowledge_entries SET origin_run_id=NULL WHERE id=?").run(linked.id);
        warnings.push("Non-interviewee promotion was retained as legacy metadata only");
      } else database.prepare("UPDATE knowledge_entries SET data_json=json_set(data_json,'$.importedPreparedLink',json('true')) WHERE id=?").run(linked.id);
    }
  }
  return count;
}

export function migrateLegacyData(database: Database.Database, root: string): LegacyMigrationReport {
  const report: LegacyMigrationReport = { importerVersion: LEGACY_IMPORTER_VERSION, checkedAt: new Date().toISOString(), sources: [] };
  const sessionFiles = ["sessions", "data/sessions"].flatMap(directory => {
    const filename = path.join(root, directory);
    return fs.existsSync(filename) ? fs.readdirSync(filename).filter(name => name.endsWith(".json")).sort().map(name => `${directory}/${name}`) : [];
  });
  for (const sourceKey of [...sessionFiles, "candidate-knowledge.json", "qa-bank.json", "qa-history.json"]) {
    const isSession = sourceKey.startsWith("sessions/") || sourceKey.startsWith("data/sessions/");
    const filename = path.join(root, isSession ? sourceKey : `data/${sourceKey}`);
    if (!fs.existsSync(filename)) continue;
    const result: LegacyImportResult = { sourceKey, status: "ERROR", count: 0, warnings: [] };
    report.sources.push(result);
    try {
      const bytes = fs.readFileSync(filename);
      const contentHash = hash(bytes);
      database.transaction(() => {
        const receipt = database.prepare("SELECT result_json FROM import_receipts WHERE origin=? AND source_key=? AND content_hash=?").get(ORIGIN, sourceKey, contentHash) as { result_json: string } | undefined;
        if (receipt) { Object.assign(result, JSON.parse(receipt.result_json).result, { status: "SKIPPED" }); return; }
        if (database.prepare("SELECT 1 FROM import_receipts WHERE origin=? AND source_key=?").get(ORIGIN, sourceKey)) throw new Error("Legacy source changed after import; explicit reconciliation required");
        const value: unknown = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
        result.count = isSession ? importSession(database, value)
          : sourceKey === "candidate-knowledge.json" ? importKnowledge(database, value)
          : sourceKey === "qa-bank.json" ? importBank(database, value) : importHistory(database, value, result.warnings);
        result.status = "COMPLETE";
        database.prepare("INSERT INTO import_receipts(id,origin,source_key,content_hash,result_json,imported_at) VALUES (?,?,?,?,?,?)")
          .run(hash(JSON.stringify([ORIGIN, sourceKey, contentHash])), ORIGIN, sourceKey, contentHash, JSON.stringify({ importerVersion: LEGACY_IMPORTER_VERSION, result, original: value }), report.checkedAt);
      }).immediate();
    } catch (error) {
      result.status = "ERROR"; result.count = 0;
      result.error = error instanceof Error ? error.message : "Legacy import failed";
    }
  }
  database.prepare("INSERT INTO app_settings(key,value_json,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,revision=app_settings.revision+1")
    .run(LEGACY_IMPORT_STATUS_KEY, JSON.stringify(report), report.checkedAt);
  return report;
}