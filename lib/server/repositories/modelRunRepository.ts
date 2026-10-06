import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getDatabase } from "../db/connection";
import type { SessionMode } from "./questionRepository";

export type RunStatus = "PENDING" | "RUNNING" | "COMPLETED" | "INTERRUPTED" | "FAILED";
export type RunSlot = "SINGLE" | "A" | "B";

export interface ModelRequestInput {
  id?: string;
  sessionId?: string;
  questionId?: string;
  promptId?: string;
  purpose: "ANSWER" | "SUMMARY" | "MEMORY" | "EXTRACTION" | "CHAT" | "LEGACY_IMPORT";
  mode?: SessionMode;
  variant?: string;
  systemInstruction?: string;
  prompt: string;
  context?: unknown;
  createdAt?: string;
}

export interface StoredModelRun {
  id: string;
  requestId: string;
  slot: RunSlot;
  provider?: string;
  model?: string;
  status: RunStatus;
  output: string;
  createdAt: string;
  finishedAt?: string;
  savedAt?: string;
  feedback?: "good" | "poor";
  feedbackAt?: string;
  error?: string;
  tag: string;
  question: string;
  scenarioContext: string;
  retrievalQuery: string;
  sessionId?: string;
  mode?: SessionMode;
  metrics: Record<string, unknown>;
}

type RunRow = {
  id: string; request_id: string; slot: RunSlot; provider: string | null; model: string | null;
  status: RunStatus; output_text: string; started_at: string; finished_at: string | null;
  saved_at: string | null; feedback: "GOOD" | "POOR" | null; feedback_at: string | null;
  error: string | null; display_tag: string; primary_ask: string | null;
  scenario_context: string | null; retrieval_query: string | null;
  session_id: string | null; mode_snapshot: SessionMode | null; metrics_json: string;
};

function fromRow(row: RunRow): StoredModelRun {
  return {
    id: row.id, requestId: row.request_id, slot: row.slot,
    provider: row.provider || undefined, model: row.model || undefined, status: row.status,
    output: row.output_text, createdAt: row.started_at, finishedAt: row.finished_at || undefined,
    savedAt: row.saved_at || undefined, feedback: row.feedback?.toLowerCase() as "good" | "poor" | undefined,
    feedbackAt: row.feedback_at || undefined, error: row.error || undefined,
    tag: row.display_tag, question: row.primary_ask || "", scenarioContext: row.scenario_context || "",
    retrievalQuery: row.retrieval_query || "", sessionId: row.session_id || undefined,
    mode: row.mode_snapshot || undefined, metrics: JSON.parse(row.metrics_json),
  };
}

const SELECT_RUN = `SELECT model_runs.*, questions.primary_ask, questions.scenario_context, questions.retrieval_query,
  model_requests.session_id, model_requests.mode_snapshot FROM model_runs
  JOIN model_requests ON model_requests.id = model_runs.request_id
  LEFT JOIN questions ON questions.id = model_requests.question_id`;

export class ModelRunRepository {
  constructor(private readonly database: Database.Database = getDatabase()) {}

  importLegacyHistory(filename = path.join(process.cwd(), "data", "qa-history.json")): number {
    if (!fs.existsSync(filename)) return 0;
    const entries: unknown = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!Array.isArray(entries)) throw new Error("Legacy answer history must be an array");
    return this.importHistory(entries);
  }

  importHistory(entries: unknown[]): number {
    return this.database.transaction(() => {
      let imported = 0;
      for (const value of entries) {
        if (!value || typeof value !== "object") throw new Error("Invalid legacy answer history entry");
        const entry = value as Record<string, unknown>;
        if (typeof entry.id !== "string" || typeof entry.answer !== "string" || !entry.answer.trim()) {
          throw new Error("Legacy answers require an id and answer");
        }
        if (this.get(entry.id)) continue;
        const createdAt = typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString();
        const mode: SessionMode = entry.callType === "taking_interview" ? "INTERVIEWER"
          : entry.callType === "meeting" ? "MEETING" : "INTERVIEWEE";
        const sessionId = typeof entry.sessionId === "string" && this.database.prepare("SELECT id FROM sessions WHERE id = ?").get(entry.sessionId)
          ? entry.sessionId : undefined;
        const questionId = `legacy-question:${entry.id}`;
        this.database.prepare("INSERT INTO questions(id, session_id, mode_snapshot, primary_ask, scenario_context, retrieval_query, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(questionId, sessionId || null, mode, String(entry.question || ""), String(entry.scenarioContext || ""), String(entry.retrievalQuery || ""), createdAt);
        const requestId = this.createRequest({ id: `legacy-request:${entry.id}`, sessionId, questionId, purpose: "LEGACY_IMPORT", mode, prompt: "", context: { legacy: entry }, createdAt });
        this.start({ id: entry.id, requestId, createdAt, tag: typeof entry.tag === "string" ? entry.tag : "AI Mode" });
        this.finish(entry.id, { status: "COMPLETED", output: entry.answer, autoSave: true });
        this.database.prepare("UPDATE model_runs SET finished_at = ?, saved_at = ?, feedback = ?, feedback_at = ? WHERE id = ?")
          .run(createdAt, createdAt, entry.feedback === "good" ? "GOOD" : entry.feedback === "poor" ? "POOR" : null,
            typeof entry.feedbackAt === "string" ? entry.feedbackAt : null, entry.id);
        if (entry.feedback === "good" && typeof entry.promotedQaEntryId === "string") {
          this.database.prepare("UPDATE knowledge_entries SET origin_run_id = ? WHERE kind = 'QA' AND json_extract(data_json, '$.id') = ? AND origin_run_id IS NULL")
            .run(entry.id, entry.promotedQaEntryId);
        }
        imported += 1;
      }
      return imported;
    }).immediate();
  }

  history(limit = 50, options: { savedOnly?: boolean; before?: string } = {}) {
    return this.list(limit, options).map((run) => {
      const promoted = this.database.prepare("SELECT data_json, updated_at FROM knowledge_entries WHERE origin_run_id = ? AND kind = 'QA' AND enabled = 1 AND review_state = 'APPROVED' LIMIT 1")
        .get(run.id) as { data_json: string; updated_at: string } | undefined;
      return {
        id: run.id, createdAt: run.createdAt, question: run.question, answer: run.output,
        scenarioContext: run.scenarioContext, retrievalQuery: run.retrievalQuery, tag: run.tag,
        sessionId: run.sessionId, callType: run.mode === "INTERVIEWER" ? "taking_interview" : run.mode === "MEETING" ? "meeting" : "giving_interview",
        feedback: run.feedback, feedbackAt: run.feedbackAt, status: run.status,
        provider: run.provider, model: run.model, slot: run.slot, metrics: run.metrics, savedAt: run.savedAt,
        promotedAt: promoted?.updated_at, promotedQaEntryId: promoted ? JSON.parse(promoted.data_json).id : undefined,
      };
    });
  }

  createRequest(input: ModelRequestInput): string {
    const id = input.id || crypto.randomUUID();
    this.database.prepare(`INSERT INTO model_requests
      (id, session_id, question_id, prompt_id, purpose, mode_snapshot, variant_snapshot,
       rendered_system_text, rendered_user_text, context_snapshot_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.sessionId || null, input.questionId || null, input.promptId || null,
        input.purpose, input.mode || null, input.variant || "standard", input.systemInstruction || "",
        input.prompt, JSON.stringify(input.context ?? {}), input.createdAt || new Date().toISOString());
    return id;
  }

  start(input: { requestId: string; slot?: RunSlot; provider?: string; model?: string; attempt?: number; tag?: string; id?: string; createdAt?: string }): string {
    const id = input.id || crypto.randomUUID();
    this.database.prepare(`INSERT INTO model_runs
      (id, request_id, slot, attempt_no, provider, model, status, started_at, display_tag, owner_pid, checkpoint_at)
      VALUES (?, ?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?, ?)`)
      .run(id, input.requestId, input.slot || "SINGLE", input.attempt || 1, input.provider || null,
        input.model || null, input.createdAt || new Date().toISOString(), input.tag || "Interview Answer", process.pid, new Date().toISOString());
    return id;
  }

  progress(id: string, output: string): void {
    this.database.prepare("UPDATE model_runs SET output_text = ?, checkpoint_at = ? WHERE id = ? AND status = 'RUNNING'").run(output, new Date().toISOString(), id);
  }

  configure(id: string, provider: string, model: string): void {
    this.database.prepare("UPDATE model_runs SET provider = ?, model = ? WHERE id = ? AND status = 'RUNNING'").run(provider, model, id);
  }

  updateMetrics(id: string, metrics: Record<string, unknown>): void {
    const run = this.get(id);
    if (run) this.database.prepare("UPDATE model_runs SET metrics_json = ? WHERE id = ?").run(JSON.stringify({ ...run.metrics, ...metrics }), id);
  }

  recoverInterruptedRuns(isAlive: (pid: number) => boolean = (pid) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  }): number {
    const owners = this.database.prepare("SELECT DISTINCT owner_pid FROM model_runs WHERE status IN ('PENDING', 'RUNNING')").all() as Array<{ owner_pid: number | null }>;
    let recovered = 0;
    for (const owner of owners) {
      if (owner.owner_pid !== null && isAlive(owner.owner_pid)) continue;
      recovered += this.database.prepare("UPDATE model_runs SET status='INTERRUPTED', finished_at=?, error='Application stopped before completion' WHERE owner_pid IS ? AND status IN ('PENDING', 'RUNNING')")
        .run(new Date().toISOString(), owner.owner_pid).changes;
    }
    return recovered;
  }

  finish(id: string, input: { status: "COMPLETED" | "INTERRUPTED" | "FAILED"; output: string; metrics?: unknown; error?: string; autoSave?: boolean }): void {
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE model_runs SET status = ?, output_text = ?, metrics_json = ?, error = ?, finished_at = ?,
      saved_at = CASE WHEN ? THEN ? ELSE saved_at END WHERE id = ? AND status IN ('RUNNING', 'PENDING')`)
      .run(input.status, input.output, JSON.stringify(input.metrics ?? {}), input.error || null, now,
        Number(Boolean(input.autoSave && input.status === "COMPLETED" && input.output.trim())), now, id);
  }

  get(id: string): StoredModelRun | null {
    const row = this.database.prepare(`${SELECT_RUN} WHERE model_runs.id = ?`).get(id) as RunRow | undefined;
    return row ? fromRow(row) : null;
  }

  list(limit = 30, options: { savedOnly?: boolean; before?: string } = {}): StoredModelRun[] {
    const rows = this.database.prepare(`${SELECT_RUN} WHERE length(trim(output_text)) > 0
      AND model_requests.purpose IN ('ANSWER', 'SUMMARY', 'LEGACY_IMPORT')
      AND (? = 0 OR saved_at IS NOT NULL) AND (? IS NULL OR started_at < ?)
      ORDER BY started_at DESC, model_runs.id DESC LIMIT ?`)
      .all(Number(Boolean(options.savedOnly)), options.before || null, options.before || null,
        Math.max(1, Math.min(limit, 100))) as RunRow[];
    return rows.map(fromRow);
  }

  rate(id: string, feedback: "good" | "poor"): StoredModelRun {
    return this.database.transaction(() => {
      const run = this.get(id);
      if (!run) throw new Error("Generated answer not found");
      if (run.status !== "COMPLETED") throw new Error("Only completed answers can be rated");
      if (feedback === "poor" && this.database.prepare("SELECT id FROM knowledge_entries WHERE origin_run_id = ? AND enabled = 1 AND review_state = 'APPROVED'").get(id)) {
        throw new Error("Remove this answer from Prepared Q&A before marking it poor");
      }
      this.database.prepare("UPDATE model_runs SET feedback = ?, feedback_at = ? WHERE id = ?")
        .run(feedback.toUpperCase(), new Date().toISOString(), id);
      return this.get(id)!;
    }).immediate();
  }

  setSaved(id: string, saved: boolean): void {
    if (!this.get(id)) throw new Error("Generated answer not found");
    this.database.prepare("UPDATE model_runs SET saved_at = ? WHERE id = ?").run(saved ? new Date().toISOString() : null, id);
  }
}