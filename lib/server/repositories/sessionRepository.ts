import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDatabase } from "../db/connection";
import { DEFAULT_KNOWLEDGE_BASE_ID } from "../db/migrations";
import { KnowledgeBaseRepository } from "./knowledgeBaseRepository";
import { indexContent } from "../retrieval/indexing";
import { EMPTY_MEETING_MEMORY } from "../../conversationTypes";
import type { MeetingMemory, SessionInfo, TranscriptTurn } from "../../conversationTypes";

export interface SessionSnapshot {
  id: string;
  startedAt: string;
  endedAt?: string;
  sessionInfo?: SessionInfo;
  transcripts: TranscriptTurn[];
  memory: MeetingMemory;
  summary?: string;
}

export interface PersistedSession extends SessionSnapshot {
  status: string;
  ownerTabId?: string;
  leaseExpiresAt?: number;
  throughSequence: number;
  memoryThroughSequence: number;
  summaryThroughSequence: number;
  summaryStatus: string;
  summaryError?: string;
}

export interface StartSessionInput {
  id: string;
  startedAt?: string;
  sessionInfo?: SessionInfo;
  ownerTabId: string;
  takeover?: boolean;
}

interface SessionRow {
  id: string; mode: keyof typeof callTypes; variant: SessionInfo["modeVariant"];
  company: string; details: string; status: string; started_at: string; ended_at: string | null;
  job_title: string; job_description: string; seniority: string; candidate_profile: string;
  summary_text: string; summary_status: string; summary_through_sequence: number; summary_error: string | null;
  memory_json: string; memory_through_sequence: number; next_sequence: number;
  accept_late_until: number | null;
  owner_tab_id: string | null; lease_expires_at: number | null;
}

const callTypes = { INTERVIEWER: "taking_interview", INTERVIEWEE: "giving_interview", MEETING: "meeting" } as const;
const modes = { taking_interview: "INTERVIEWER", giving_interview: "INTERVIEWEE", meeting: "MEETING" } as const;
const LEASE_MS = 45_000;

export class SessionPersistenceError extends Error {
  constructor(message: string, public readonly status = 409) { super(message); }
}

export class SessionRepository {
  constructor(private readonly suppliedDatabase?: Database.Database) {}
  private get database() { return this.suppliedDatabase ?? getDatabase(); }

  private row(id: string): SessionRow {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) throw new SessionPersistenceError("Session not found", 404);
    return row;
  }

  private owner(row: SessionRow, ownerTabId: string) {
    if (!ownerTabId || row.owner_tab_id !== ownerTabId) throw new SessionPersistenceError("Session belongs to another tab; explicit takeover or a new session is required");
  }

  private mode(info?: SessionInfo) {
    const callType = info?.callType ?? "taking_interview";
    if (!Object.hasOwn(modes, callType)) throw new SessionPersistenceError("Invalid session mode", 400);
    if (info?.modeVariant && !["standard", "course_admission"].includes(info.modeVariant)) throw new SessionPersistenceError("Invalid variant", 400);
    return modes[callType];
  }

  private writeInfo(row: SessionRow, info?: SessionInfo) {
    if (!info) return;
    const mode = this.mode(info);
    if (row.next_sequence && mode !== row.mode) throw new SessionPersistenceError("Session mode is locked after the first turn");
    if (row.status !== "ACTIVE") return;
    this.writeSelections(row.id, info, mode);
    this.database.prepare("UPDATE sessions SET mode=?, variant=?, company=?, details=?, job_title=?, job_description=?, seniority=?, candidate_profile=? WHERE id=?")
      .run(mode, info.modeVariant ?? "standard", info.company, info.details,
        mode === "INTERVIEWEE" ? this.contextText(info.jobTitle, row.job_title, 200, "Job title") : "",
        mode === "INTERVIEWEE" ? this.contextText(info.jobDescription, row.job_description) : "",
        mode === "INTERVIEWEE" ? this.contextText(info.seniority, row.seniority, 100, "Seniority") : "",
        mode === "INTERVIEWER" ? this.contextText(info.candidateProfile, row.candidate_profile) : "", row.id);
  }

  private contextText(value: unknown, previous = "", maxLength = 12_000, label = "Interview context"): string {
    if (value === undefined) return previous;
    if (typeof value !== "string" || value.length > maxLength) throw new SessionPersistenceError(`${label} must be text of at most ${maxLength} characters`, 400);
    return value.trim();
  }

  private writeSelections(id: string, info: SessionInfo | undefined, mode: string) {
    const selections = mode === "INTERVIEWEE" ? [DEFAULT_KNOWLEDGE_BASE_ID]
      : mode === "INTERVIEWER" ? [] : info?.knowledgeBaseIds;
    if (selections === undefined) return;
    const bases = new KnowledgeBaseRepository(this.database).validateSelections(selections, mode);
    this.database.prepare("DELETE FROM session_knowledge_bases WHERE session_id=?").run(id);
    const insert = this.database.prepare("INSERT INTO session_knowledge_bases(session_id,knowledge_base_id) VALUES (?,?)");
    for (const base of bases) insert.run(id, base.id);
  }

  start(input: StartSessionInput): PersistedSession {
    if (!input.id || !input.ownerTabId) throw new SessionPersistenceError("Session id and owner are required", 400);
    const mode = this.mode(input.sessionInfo);
    this.database.transaction(() => {
      const existing = this.database.prepare("SELECT * FROM sessions WHERE id=?").get(input.id) as SessionRow | undefined;
      if (existing) {
        if (existing.owner_tab_id !== input.ownerTabId) {
          if (!input.takeover || (existing.lease_expires_at ?? 0) > Date.now()) throw new SessionPersistenceError("Session lease is owned by another tab");
          if (existing.status !== "ACTIVE") throw new SessionPersistenceError("Ended sessions cannot be taken over");
          this.database.prepare("UPDATE sessions SET owner_tab_id=? WHERE id=?").run(input.ownerTabId, input.id);
        }
        this.writeInfo(existing, input.sessionInfo);
        if (existing.status === "ACTIVE") this.database.prepare("UPDATE sessions SET lease_expires_at=? WHERE id=?").run(Date.now() + LEASE_MS, input.id);
        return;
      }
      this.database.prepare(`INSERT INTO sessions(id,mode,variant,company,details,job_title,job_description,seniority,candidate_profile,started_at,owner_tab_id,lease_expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, mode, input.sessionInfo?.modeVariant ?? "standard", input.sessionInfo?.company ?? "", input.sessionInfo?.details ?? "",
          mode === "INTERVIEWEE" ? this.contextText(input.sessionInfo?.jobTitle, "", 200, "Job title") : "",
          mode === "INTERVIEWEE" ? this.contextText(input.sessionInfo?.jobDescription) : "",
          mode === "INTERVIEWEE" ? this.contextText(input.sessionInfo?.seniority, "", 100, "Seniority") : "",
          mode === "INTERVIEWER" ? this.contextText(input.sessionInfo?.candidateProfile) : "",
          input.startedAt ?? new Date().toISOString(), input.ownerTabId, Date.now() + LEASE_MS);
      this.writeSelections(input.id, input.sessionInfo, mode);
    })();
    return this.get(input.id)!;
  }

  upsert(input: StartSessionInput) { return this.start(input); }

  private insertTurns(row: SessionRow, turns: TranscriptTurn[]) {
    let sequence = row.next_sequence;
    const exists = this.database.prepare("SELECT 1 FROM transcript_turns WHERE session_id=? AND client_turn_id=?");
    const insert = this.database.prepare(`INSERT INTO transcript_turns(id,session_id,client_turn_id,sequence_no,speaker,text,captured_at,received_at,audio_start,audio_end,confidence,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const turn of turns) {
      if (!turn.id || !turn.text.trim() || turn.isInterim || !["me", "interviewer"].includes(turn.speaker)) throw new SessionPersistenceError("Invalid finalized transcript turn", 400);
      if (exists.get(row.id, turn.id)) continue;
      const turnId = randomUUID();
      insert.run(turnId, row.id, turn.id, ++sequence, turn.speaker === "me" ? "LOCAL" : "REMOTE", turn.text.trim(), turn.timestamp, new Date().toISOString(), turn.audioStart ?? null, turn.audioEnd ?? null, turn.confidence ?? null, JSON.stringify({ sequenceId: turn.sequenceId }));
      indexContent(this.database, "transcript_turn_id", turnId, `Turn ${sequence}`, turn.text.trim());
    }
    this.database.prepare("UPDATE sessions SET next_sequence=? WHERE id=?").run(sequence, row.id);
  }

  appendTurns(id: string, turns: TranscriptTurn[], ownerTabId: string) {
    this.database.transaction(() => {
      const row = this.row(id);
      this.owner(row, ownerTabId);
      if (row.status === "ENDED" && (row.accept_late_until ?? 0) < Date.now()
        && turns.some(turn => !this.database.prepare("SELECT 1 FROM transcript_turns WHERE session_id=? AND client_turn_id=?").get(id, turn.id))) {
        throw new SessionPersistenceError("Late transcript grace expired; saved turns are unchanged");
      }
      this.insertTurns(row, turns);
      if (row.status === "ACTIVE") this.database.prepare("UPDATE sessions SET lease_expires_at=? WHERE id=?").run(Date.now() + LEASE_MS, id);
    })();
    return this.get(id)!;
  }

  end(id: string, ownerTabId: string, turns: TranscriptTurn[] = [], endedAt = new Date().toISOString()) {
    this.database.transaction(() => {
      const row = this.row(id);
      this.owner(row, ownerTabId);
      this.insertTurns(row, turns);
      this.database.prepare("UPDATE sessions SET status='ENDED', ended_at=COALESCE(ended_at,?), accept_late_until=COALESCE(accept_late_until,?), lease_expires_at=NULL WHERE id=?").run(endedAt, Date.now() + 120_000, id);
    })();
    return this.get(id)!;
  }

  saveSnapshot(snapshot: SessionSnapshot, ownerTabId: string) {
    return this.database.transaction(() => {
      this.start({ ...snapshot, ownerTabId });
      this.appendTurns(snapshot.id, snapshot.transcripts, ownerTabId);
      this.updateMemory(snapshot.id, snapshot.memory, this.row(snapshot.id).next_sequence, ownerTabId);
      return snapshot.endedAt ? this.end(snapshot.id, ownerTabId, [], snapshot.endedAt) : this.get(snapshot.id)!;
    })();
  }

  importSnapshot(snapshot: SessionSnapshot) {
    return this.database.transaction(() => {
      const existing = this.get(snapshot.id, false);
      if (existing?.ownerTabId) throw new SessionPersistenceError("Import cannot modify a live-owned session");
      if (!existing) this.database.prepare(`INSERT INTO sessions(id,mode,variant,company,details,started_at,memory_json)
        VALUES (?,?,?,?,?,?,?)`).run(snapshot.id, this.mode(snapshot.sessionInfo), snapshot.sessionInfo?.modeVariant ?? "standard", snapshot.sessionInfo?.company ?? "", snapshot.sessionInfo?.details ?? "", snapshot.startedAt, JSON.stringify(snapshot.memory));
      const row = this.row(snapshot.id);
      this.writeInfo(row, snapshot.sessionInfo);
      this.insertTurns(row, snapshot.transcripts);
      this.database.prepare("UPDATE sessions SET memory_json=?,memory_through_sequence=next_sequence WHERE id=? AND memory_through_sequence=0").run(JSON.stringify(snapshot.memory), snapshot.id);
      if (snapshot.summary) this.updateSummary(snapshot.id, snapshot.summary, this.row(snapshot.id).next_sequence);
      if (snapshot.endedAt) this.database.prepare("UPDATE sessions SET status='ENDED',ended_at=COALESCE(ended_at,?) WHERE id=?").run(snapshot.endedAt, snapshot.id);
      return this.get(snapshot.id)!;
    })();
  }

  get(id: string, includeTranscripts = true): PersistedSession | null {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id=?").get(id) as SessionRow | undefined;
    if (!row) return null;
    const selectedBases = this.database.prepare("SELECT knowledge_base_id FROM session_knowledge_bases WHERE session_id=? ORDER BY knowledge_base_id").all(id) as Array<{ knowledge_base_id: string }>;
    const transcripts = includeTranscripts ? (this.database.prepare("SELECT * FROM transcript_turns WHERE session_id=? ORDER BY sequence_no").all(id) as Array<{ client_turn_id: string; sequence_no: number; speaker: string; text: string; captured_at: string; audio_start: number | null; audio_end: number | null; confidence: number | null }>).map(turn => ({
      id: turn.client_turn_id, sequenceId: turn.sequence_no, speaker: turn.speaker === "LOCAL" ? "me" as const : "interviewer" as const, text: turn.text, timestamp: turn.captured_at,
      audioStart: turn.audio_start ?? undefined, audioEnd: turn.audio_end ?? undefined, confidence: turn.confidence ?? undefined, isInterim: false,
    })) : [];
    return { id: row.id, startedAt: row.started_at, endedAt: row.ended_at ?? undefined, transcripts,
      memory: { ...EMPTY_MEETING_MEMORY, ...JSON.parse(row.memory_json) }, summary: row.summary_text || undefined,
      sessionInfo: { company: row.company, details: row.details, callType: callTypes[row.mode], modeVariant: row.variant,
        jobTitle: row.job_title || undefined, jobDescription: row.job_description || undefined, seniority: row.seniority || undefined,
        candidateProfile: row.candidate_profile || undefined,
        knowledgeBaseIds: row.mode === "INTERVIEWER" ? [] : selectedBases.length ? selectedBases.map(base => base.knowledge_base_id) : undefined },
      status: row.status, ownerTabId: row.owner_tab_id ?? undefined, leaseExpiresAt: row.lease_expires_at ?? undefined,
      throughSequence: row.next_sequence, memoryThroughSequence: row.memory_through_sequence, summaryThroughSequence: row.summary_through_sequence,
      summaryStatus: row.summary_status, summaryError: row.summary_error ?? undefined };
  }

  list(options: { limit?: number; cursor?: string; includeTranscripts?: boolean } = {}) {
    const limit = Math.max(1, Math.min(100, options.limit ?? 100));
    const rows = this.database.prepare("SELECT id FROM sessions WHERE (? IS NULL OR (started_at || '|' || id) < ?) ORDER BY started_at DESC,id DESC LIMIT ?")
      .all(options.cursor ?? null, options.cursor ?? null, limit) as Array<{ id: string }>;
    return rows.map(row => this.get(row.id, options.includeTranscripts ?? false)!);
  }

  restoreActive(id?: string) {
    if (id) { const session = this.get(id); return session?.status === "ACTIVE" ? session : null; }
    const row = this.database.prepare("SELECT id FROM sessions WHERE status='ACTIVE' ORDER BY started_at DESC,id DESC LIMIT 1").get() as { id: string } | undefined;
    return row ? this.get(row.id) : null;
  }

  updateMemory(id: string, memory: MeetingMemory, coveredThroughSequence: number, ownerTabId: string) {
    const row = this.row(id);
    this.owner(row, ownerTabId);
    this.coverage(coveredThroughSequence, row.next_sequence);
    this.database.prepare("UPDATE sessions SET memory_json=?,memory_through_sequence=? WHERE id=? AND memory_through_sequence<? AND status='ACTIVE'")
      .run(JSON.stringify(memory), coveredThroughSequence, id, coveredThroughSequence);
    return this.get(id)!;
  }

  private coverage(sequence: number, maximum: number) {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > maximum) throw new SessionPersistenceError("Invalid sequence coverage", 400);
  }

  updateSummary(id: string, summary: string, coveredThroughSequence: number) {
    this.coverage(coveredThroughSequence, this.row(id).next_sequence);
    const result = this.database.prepare("UPDATE sessions SET summary_text=?,summary_through_sequence=?,summary_status=CASE WHEN next_sequence=? THEN 'READY' ELSE summary_status END,summary_error=NULL WHERE id=? AND summary_through_sequence<=?")
      .run(summary, coveredThroughSequence, coveredThroughSequence, id, coveredThroughSequence);
    if (result.changes) indexContent(this.database, "summary_session_id", id, "Session summary", summary);
  }

  // Returns how many turns the summary will cover, or null when no summary should start.
  claimSummary(id: string, manual = false): number | null {
    return this.database.transaction(() => {
      const claimed = this.database.prepare(`UPDATE sessions SET summary_status='PENDING',summary_error=NULL
        WHERE id=? AND status='ENDED' AND next_sequence>0 AND summary_status!='PENDING' AND (?=1 OR summary_status='NONE')`).run(id, manual ? 1 : 0);
      return claimed.changes ? this.row(id).next_sequence : null;
    })();
  }

  completeSummary(id: string, summary: string, coveredThroughSequence: number): boolean {
    return this.database.transaction(() => {
      const result = this.database.prepare("UPDATE sessions SET summary_text=?,summary_through_sequence=?,summary_status='READY',summary_error=NULL WHERE id=? AND summary_status='PENDING'")
        .run(summary, coveredThroughSequence, id);
      if (result.changes) indexContent(this.database, "summary_session_id", id, "Session summary", summary);
      return result.changes > 0;
    })();
  }

  failSummary(id: string, error: string): void {
    this.database.prepare("UPDATE sessions SET summary_status='FAILED',summary_error=? WHERE id=? AND summary_status='PENDING'").run(error.slice(0, 2000), id);
  }

  recoverInterruptedSummaries(): number {
    return this.database.prepare("UPDATE sessions SET summary_status='FAILED',summary_error='The app stopped before this summary finished. Retry it.' WHERE summary_status='PENDING'").run().changes;
  }
}

export const sessionRepository = new SessionRepository();
export default sessionRepository;