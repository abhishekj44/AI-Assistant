import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDatabase } from "../db/connection";
import { DEFAULT_KNOWLEDGE_BASE_ID, LOCAL_PROFILE_ID } from "../db/migrations";
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
  revision: number;
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
  job_description: string; candidate_profile: string;
  summary_text: string; summary_status: string; summary_through_sequence: number;
  memory_json: string; memory_through_sequence: number; next_sequence: number;
  accept_late_until: number | null;
  owner_tab_id: string | null; lease_expires_at: number | null; revision: number;
}

export interface SessionJob {
  id: string;
  session_id: string;
  attempts: number;
  locked_until: number;
  parameters_json: string;
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
    this.database.prepare("UPDATE sessions SET mode=?, variant=?, company=?, details=?, job_description=?, candidate_profile=?, revision=revision+1 WHERE id=?")
      .run(mode, info.modeVariant ?? "standard", info.company, info.details,
        mode === "INTERVIEWEE" ? this.contextText(info.jobDescription, row.job_description) : "",
        mode === "INTERVIEWER" ? this.contextText(info.candidateProfile, row.candidate_profile) : "", row.id);
  }

  private contextText(value: unknown, previous = ""): string {
    if (value === undefined) return previous;
    if (typeof value !== "string" || value.length > 12_000) throw new SessionPersistenceError("Interview context must be text of at most 12000 characters", 400);
    return value.trim();
  }

  private writeSelections(id: string, info: SessionInfo | undefined, mode: string) {
    const selections = mode === "INTERVIEWEE" ? [DEFAULT_KNOWLEDGE_BASE_ID]
      : mode === "INTERVIEWER" ? [] : info?.knowledgeBaseIds;
    if (selections === undefined) return;
    const bases = new KnowledgeBaseRepository(this.database).validateSelections(selections, mode);
    this.database.prepare("DELETE FROM session_knowledge_bases WHERE session_id=?").run(id);
    const insert = this.database.prepare("INSERT INTO session_knowledge_bases(session_id,knowledge_base_id,usage_role) VALUES (?,?,?)");
    const roles = { PERSONAL: "PERSONAL_FACTS", JOB: "JOB_CONTEXT", REFERENCE: "REFERENCE" } as const;
    for (const base of bases) insert.run(id, base.id, roles[base.kind]);
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
        if (existing.status === "ACTIVE") this.database.prepare("UPDATE sessions SET lease_expires_at=?, revision=revision+1 WHERE id=?").run(Date.now() + LEASE_MS, input.id);
        return;
      }
      this.database.prepare(`INSERT INTO sessions(id,local_profile_id,mode,variant,company,details,job_description,candidate_profile,started_at,owner_tab_id,lease_expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(input.id, LOCAL_PROFILE_ID, mode, input.sessionInfo?.modeVariant ?? "standard", input.sessionInfo?.company ?? "", input.sessionInfo?.details ?? "",
          mode === "INTERVIEWEE" ? this.contextText(input.sessionInfo?.jobDescription) : "",
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
    this.database.prepare("UPDATE sessions SET next_sequence=?, revision=revision+1 WHERE id=?").run(sequence, row.id);
    if (sequence !== row.next_sequence && row.status === "ENDED") this.enqueueSummary(row.id, sequence);
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
      this.database.prepare("UPDATE sessions SET status='ENDED', ended_at=COALESCE(ended_at,?), accept_late_until=COALESCE(accept_late_until,?), lease_expires_at=NULL, revision=revision+1 WHERE id=?").run(endedAt, Date.now() + 120_000, id);
      this.enqueueSummary(id, this.row(id).next_sequence);
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
      if (!existing) this.database.prepare(`INSERT INTO sessions(id,local_profile_id,mode,variant,company,details,started_at,memory_json)
        VALUES (?,?,?,?,?,?,?,?)`).run(snapshot.id, LOCAL_PROFILE_ID, this.mode(snapshot.sessionInfo), snapshot.sessionInfo?.modeVariant ?? "standard", snapshot.sessionInfo?.company ?? "", snapshot.sessionInfo?.details ?? "", snapshot.startedAt, JSON.stringify(snapshot.memory));
      const row = this.row(snapshot.id);
      this.writeInfo(row, snapshot.sessionInfo);
      this.insertTurns(row, snapshot.transcripts);
      this.database.prepare("UPDATE sessions SET memory_json=?,memory_through_sequence=next_sequence WHERE id=? AND memory_through_sequence=0").run(JSON.stringify(snapshot.memory), snapshot.id);
      if (snapshot.summary) this.updateSummary(snapshot.id, snapshot.summary, this.row(snapshot.id).next_sequence);
      if (snapshot.endedAt) {
        this.database.prepare("UPDATE sessions SET status='ENDED',ended_at=COALESCE(ended_at,?) WHERE id=?").run(snapshot.endedAt, snapshot.id);
        if (!snapshot.summary) this.enqueueSummary(snapshot.id, this.row(snapshot.id).next_sequence);
      }
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
        jobDescription: row.job_description || undefined, candidateProfile: row.candidate_profile || undefined,
        knowledgeBaseIds: row.mode === "INTERVIEWER" ? [] : selectedBases.length ? selectedBases.map(base => base.knowledge_base_id) : undefined },
      status: row.status, ownerTabId: row.owner_tab_id ?? undefined, leaseExpiresAt: row.lease_expires_at ?? undefined,
      throughSequence: row.next_sequence, memoryThroughSequence: row.memory_through_sequence, summaryThroughSequence: row.summary_through_sequence,
      summaryStatus: row.summary_status, revision: row.revision };
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
    this.database.prepare("UPDATE sessions SET memory_json=?,memory_through_sequence=?,revision=revision+1 WHERE id=? AND memory_through_sequence<? AND status='ACTIVE'")
      .run(JSON.stringify(memory), coveredThroughSequence, id, coveredThroughSequence);
    return this.get(id)!;
  }

  private coverage(sequence: number, maximum: number) {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > maximum) throw new SessionPersistenceError("Invalid sequence coverage", 400);
  }

  updateSummary(id: string, summary: string, coveredThroughSequence: number) {
    this.coverage(coveredThroughSequence, this.row(id).next_sequence);
    const result = this.database.prepare("UPDATE sessions SET summary_text=?,summary_through_sequence=?,summary_status=CASE WHEN next_sequence=? THEN 'READY' ELSE summary_status END,summary_error=NULL,revision=revision+1 WHERE id=? AND summary_through_sequence<=?")
      .run(summary, coveredThroughSequence, coveredThroughSequence, id, coveredThroughSequence);
    if (result.changes) indexContent(this.database, "summary_session_id", id, "Session summary", summary);
  }

  private enqueueSummary(id: string, sequence: number) {
    if (!sequence) return;
    const now = new Date().toISOString();
    const result = this.database.prepare("INSERT OR IGNORE INTO background_jobs(id,kind,session_id,dedupe_key,parameters_json,created_at,updated_at) VALUES (?,'SUMMARY',?,?,?,?,?)")
      .run(randomUUID(), id, `summary:${id}:${sequence}`, JSON.stringify({ coveredThroughSequence: sequence }), now, now);
    if (result.changes) this.database.prepare("UPDATE sessions SET summary_status='PENDING',summary_error=NULL WHERE id=?").run(id);
  }

  claimJob(): SessionJob | null {
    return this.database.transaction(() => {
      const now = Date.now();
      const job = this.database.prepare("SELECT * FROM background_jobs WHERE kind='SUMMARY' AND ((status='PENDING' AND run_after<=?) OR (status='RUNNING' AND locked_until<=?)) ORDER BY created_at LIMIT 1").get(now, now) as SessionJob | undefined;
      if (!job) return null;
      const lockedUntil = now + 90_000;
      this.database.prepare("UPDATE background_jobs SET status='RUNNING',attempts=attempts+1,locked_until=?,updated_at=? WHERE id=?").run(lockedUntil, new Date().toISOString(), job.id);
      return { ...job, attempts: job.attempts + 1, locked_until: lockedUntil };
    })();
  }

  completeJob(job: SessionJob, summary: string) {
    this.database.transaction(() => {
      if (!this.jobOwned(job)) return;
      this.updateSummary(job.session_id, summary, JSON.parse(job.parameters_json).coveredThroughSequence);
      this.database.prepare("UPDATE background_jobs SET status='SUCCEEDED',locked_until=NULL,error=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), job.id);
    })();
  }

  private jobOwned(job: SessionJob) {
    return this.database.prepare("SELECT 1 FROM background_jobs WHERE id=? AND status='RUNNING' AND attempts=? AND locked_until=?").get(job.id, job.attempts, job.locked_until);
  }

  failJob(job: SessionJob, error: string) {
    this.database.transaction(() => {
      if (!this.jobOwned(job)) return;
      const failed = job.attempts >= 5;
      this.database.prepare("UPDATE background_jobs SET status=?,run_after=?,locked_until=NULL,error=?,updated_at=? WHERE id=?")
        .run(failed ? "FAILED" : "PENDING", Date.now() + Math.min(300_000, 1000 * 2 ** job.attempts), error.slice(0, 2000), new Date().toISOString(), job.id);
      this.database.prepare("UPDATE sessions SET summary_status=?,summary_error=? WHERE id=? AND next_sequence=? AND summary_through_sequence<=?")
        .run(failed ? "FAILED" : "PENDING", error.slice(0, 2000), job.session_id, JSON.parse(job.parameters_json).coveredThroughSequence, JSON.parse(job.parameters_json).coveredThroughSequence);
    })();
  }
}

export const sessionRepository = new SessionRepository();
export default sessionRepository;