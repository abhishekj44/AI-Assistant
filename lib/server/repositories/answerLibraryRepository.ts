import type Database from "better-sqlite3";
import { EMPTY_QA_BANK, type QABank, type QAEntry } from "../../qa/types";
import { getDatabase } from "../db/connection";
import { DEFAULT_KNOWLEDGE_BASE_ID, LOCAL_PROFILE_ID } from "../db/migrations";
import { indexContent } from "../retrieval/indexing";
import { cleanString, sanitizeQAEntry } from "../retrieval/qaSanitization";
import { normalizeSearch } from "../retrieval/normalization";

export interface QAWriteOptions { originRunId?: string; preserveTimestamps?: boolean }
interface QARow { id: string; data_json: string; enabled: number; review_state: string; created_at: string; updated_at: string; origin_run_id: string | null }

export class AnswerLibraryRepository {
  constructor(private readonly database: Database.Database = getDatabase()) {}

  readBank(baseId = DEFAULT_KNOWLEDGE_BASE_ID): QABank {
    const base = this.base(baseId);
    const rows = this.database.prepare("SELECT id, data_json, enabled, review_state, created_at, updated_at, origin_run_id FROM knowledge_entries WHERE knowledge_base_id = ? AND kind = 'QA' ORDER BY created_at DESC, id").all(baseId) as QARow[];
    const metadata = this.database.prepare("SELECT value_json FROM app_settings WHERE key = ?").get(`qa-bank:${baseId}`) as { value_json: string } | undefined;
    return { ...EMPTY_QA_BANK, updatedAt: metadata ? JSON.parse(metadata.value_json).updatedAt : rows.length ? base.updated_at : new Date(0).toISOString(), entries: rows.map((row) => {
      const { importedPreparedLink: _link, ...entry } = JSON.parse(row.data_json);
      return { ...entry, enabled: row.enabled === 1 && row.review_state === "APPROVED", createdAt: row.created_at, updatedAt: row.updated_at };
    }) };
  }

  upsertQA(value: unknown, baseId = DEFAULT_KNOWLEDGE_BASE_ID, options: QAWriteOptions = {}): QABank {
    return this.database.transaction(() => {
      const bank = this.readBank(baseId);
      const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const existing = bank.entries.find((entry) => entry.id === raw.id);
      const entry = sanitizeQAEntry(value, existing);
      if (options.preserveTimestamps && typeof raw.updatedAt === "string") entry.updatedAt = cleanString(raw.updatedAt, 80);
      if (bank.entries.some((other) => other.id !== entry.id && other.questions.some((question) => normalizeSearch(question) === normalizeSearch(entry.questions[0])))) throw new Error("A Q&A entry with the same primary question already exists");
      this.writeEntry(entry, baseId, options);
      this.touch(baseId, entry.updatedAt);
      return this.readBank(baseId);
    })();
  }

  importBank(value: unknown, mode: "merge" | "replace" = "merge", baseId = DEFAULT_KNOWLEDGE_BASE_ID, preserveTimestamps = false): QABank {
    if (!value || typeof value !== "object" || !Array.isArray((value as QABank).entries)) throw new Error("Invalid Q&A bank");
    const raw = value as QABank;
    if (Buffer.byteLength(JSON.stringify(value)) > 12 * 1024 * 1024 || raw.entries.length > 10_000) throw new Error("Q&A import exceeds the supported import limit");
    const entries = raw.entries.map((item) => {
      const entry = sanitizeQAEntry(item);
      if (preserveTimestamps && item.updatedAt) entry.updatedAt = cleanString(item.updatedAt, 80);
      return entry;
    });
    return this.database.transaction(() => {
      this.base(baseId);
      if (mode === "replace") this.database.prepare("DELETE FROM knowledge_entries WHERE knowledge_base_id = ? AND kind = 'QA'").run(baseId);
      for (const entry of entries) {
        const bank = this.readBank(baseId);
        const duplicate = bank.entries.find((other) => other.id === entry.id || other.questions.some((question) => entry.questions.some((candidate) => normalizeSearch(candidate) === normalizeSearch(question))));
        this.writeEntry(duplicate ? { ...entry, id: duplicate.id, createdAt: duplicate.createdAt } : entry, baseId, { preserveTimestamps });
      }
      this.touch(baseId, preserveTimestamps && raw.updatedAt ? raw.updatedAt : new Date().toISOString());
      return this.readBank(baseId);
    })();
  }

  deleteQA(id: string, baseId = DEFAULT_KNOWLEDGE_BASE_ID): QABank {
    return this.database.transaction(() => {
      this.base(baseId);
      const result = this.database.prepare("DELETE FROM knowledge_entries WHERE id = ? AND knowledge_base_id = ? AND kind = 'QA'").run(this.entryId(id, baseId), baseId);
      if (!result.changes) throw new Error("Q&A entry not found");
      this.touch(baseId);
      return this.readBank(baseId);
    })();
  }

  clearQA(baseId = DEFAULT_KNOWLEDGE_BASE_ID): QABank {
    return this.database.transaction(() => {
      this.base(baseId);
      this.database.prepare("DELETE FROM knowledge_entries WHERE knowledge_base_id = ? AND kind = 'QA'").run(baseId);
      this.touch(baseId);
      return this.readBank(baseId);
    })();
  }

  promoteRun(runId: string, baseId = DEFAULT_KNOWLEDGE_BASE_ID): { entryId: string; alreadyExists: boolean; bank: QABank } {
    return this.database.transaction(() => {
      const base = this.base(baseId);
      if (base.kind !== "PERSONAL" || base.profile_id !== LOCAL_PROFILE_ID) throw new Error("Promotion requires the local personal profile");
      const run = this.database.prepare(`SELECT run.status, run.feedback, run.output_text, request.mode_snapshot, question.mode_snapshot AS question_mode,
        question.primary_ask, request.session_id, session.local_profile_id
        FROM model_runs run JOIN model_requests request ON request.id = run.request_id
        LEFT JOIN questions question ON question.id = request.question_id LEFT JOIN sessions session ON session.id = request.session_id WHERE run.id = ?`).get(runId) as { status: string; feedback: string; output_text: string; mode_snapshot: string | null; question_mode: string | null; primary_ask: string | null; session_id: string | null; local_profile_id: string | null } | undefined;
      if (!run) throw new Error("Model run not found");
      if (run.status !== "COMPLETED" || run.feedback !== "GOOD") throw new Error("Promotion requires a completed Good run");
      if (run.session_id && run.local_profile_id !== LOCAL_PROFILE_ID) throw new Error("Run belongs to another personal profile");
      const existing = this.database.prepare("SELECT id, data_json, enabled, review_state FROM knowledge_entries WHERE knowledge_base_id = ? AND origin_run_id = ? AND kind = 'QA'").get(baseId, runId) as QARow | undefined;
      const mode = run.mode_snapshot || run.question_mode;
      const legacyLink = existing && JSON.parse(existing.data_json).importedPreparedLink === true;
      if (mode !== "INTERVIEWEE" && !(mode === null && legacyLink)) throw new Error("Only INTERVIEWEE runs can be promoted");
      if (existing) {
        if (!existing.enabled || existing.review_state !== "APPROVED") throw new Error("Existing Q&A must be enabled and approved");
        return { entryId: JSON.parse(existing.data_json).id, alreadyExists: true, bank: this.readBank(baseId) };
      }
      const entry = sanitizeQAEntry({ id: `run_${runId}`, questions: [run.primary_ask], answer: run.output_text, personal: true });
      this.upsertQA(entry, baseId, { originRunId: runId });
      return { entryId: entry.id, alreadyExists: false, bank: this.readBank(baseId) };
    })();
  }

  private base(baseId: string): { profile_id: string | null; kind: string; updated_at: string } {
    const row = this.database.prepare("SELECT profile_id, kind, updated_at FROM knowledge_bases WHERE id = ?").get(baseId) as { profile_id: string | null; kind: string; updated_at: string } | undefined;
    if (!row) throw new Error("Knowledge base not found");
    return row;
  }

  private entryId(id: string, baseId: string): string { return `qa:${JSON.stringify([baseId, id])}`; }

  private touch(baseId: string, now = new Date().toISOString()): void {
    this.database.prepare("UPDATE knowledge_bases SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, baseId);
    this.database.prepare("INSERT INTO app_settings(key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, revision=app_settings.revision + 1, updated_at=excluded.updated_at")
      .run(`qa-bank:${baseId}`, JSON.stringify({ updatedAt: now }), now);
  }

  private writeEntry(entry: QAEntry, baseId: string, options: QAWriteOptions): void {
    const id = this.entryId(entry.id, baseId);
    const previous = this.database.prepare("SELECT origin_run_id, data_json FROM knowledge_entries WHERE id = ? AND knowledge_base_id = ?").get(id, baseId) as { origin_run_id: string | null; data_json: string } | undefined;
    const originRunId = options.originRunId || previous?.origin_run_id || null;
    const legacyLink = options.preserveTimestamps && options.originRunId || previous && JSON.parse(previous.data_json).importedPreparedLink;
    if (originRunId) {
      const base = this.base(baseId);
      const run = this.database.prepare(`SELECT run.status, run.feedback, request.mode_snapshot, question.mode_snapshot AS question_mode, request.session_id, session.local_profile_id
        FROM model_runs run JOIN model_requests request ON request.id = run.request_id
        LEFT JOIN questions question ON question.id = request.question_id LEFT JOIN sessions session ON session.id = request.session_id WHERE run.id = ?`).get(originRunId) as { status: string; feedback: string | null; mode_snapshot: string | null; question_mode: string | null; session_id: string | null; local_profile_id: string | null } | undefined;
      if (!run || run.status !== "COMPLETED" || run.feedback !== "GOOD") throw new Error("Origin requires a completed Good run");
      if (base.kind !== "PERSONAL" || base.profile_id !== LOCAL_PROFILE_ID || run.session_id && run.local_profile_id !== LOCAL_PROFILE_ID) throw new Error("Origin requires the local personal profile");
      const mode = run.mode_snapshot || run.question_mode;
      if (mode !== "INTERVIEWEE" && !(mode === null && legacyLink)) throw new Error("Only INTERVIEWEE runs can enter prepared Q&A");
    }
    const data = legacyLink ? { ...entry, importedPreparedLink: true } : entry;
    this.database.prepare(`INSERT INTO knowledge_entries(id, knowledge_base_id, kind, title, question, content, data_json, tags_json, enabled, priority, origin_run_id, created_at, updated_at)
      VALUES (?, ?, 'QA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, question=excluded.question, content=excluded.content, data_json=excluded.data_json, tags_json=excluded.tags_json, enabled=excluded.enabled, priority=excluded.priority, origin_run_id=excluded.origin_run_id, updated_at=excluded.updated_at`)
      .run(id, baseId, entry.questions[0], entry.questions[0], entry.answer, JSON.stringify(data), JSON.stringify(entry.tags), entry.enabled ? 1 : 0, entry.priority, originRunId, entry.createdAt, entry.updatedAt);
    this.database.prepare("DELETE FROM knowledge_variants WHERE entry_id = ?").run(id);
    const variants = this.database.prepare("INSERT INTO knowledge_variants(id, entry_id, alternate_question, normalized_question, position) VALUES (?, ?, ?, ?, ?)");
    const seen = new Set<string>();
    entry.questions.forEach((question, position) => {
      const normalized = normalizeSearch(question);
      if (seen.has(normalized)) return;
      seen.add(normalized);
      variants.run(`${id}:${position}`, id, question, normalized, position);
    });
    indexContent(this.database, "entry_id", id, entry.questions[0], [...entry.questions, entry.answer, ...entry.keyPoints, ...entry.tags, entry.category || ""].join("\n"));
  }
}