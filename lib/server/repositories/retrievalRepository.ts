import type Database from "better-sqlite3";
import { getDatabase } from "../db/connection";
import { DEFAULT_KNOWLEDGE_BASE_ID } from "../db/migrations";
import { searchTokens } from "../retrieval/normalization";

export type RetrievalSourceKind = "ENTRY" | "DOCUMENT" | "QA" | "QUESTION" | "SUMMARY" | "TRANSCRIPT";
export interface RetrievalOptions {
  baseIds?: string[];
  sessionId?: string;
  contextHint?: string;
  limit?: number;
  sourceKinds?: RetrievalSourceKind[];
  tokenBudget?: number;
}
export interface RetrievalResult {
  id: string;
  ownerId: string;
  title: string;
  text: string;
  rank: number;
  tokenEstimate: number;
  sourceKind: RetrievalSourceKind;
  provenance: { baseId: string | null; documentId: string | null; entryId: string | null; questionId: string | null; sessionId: string | null; turnId: string | null; chunkIndex: number; entryKind: string | null; sourceId: string | null; qaId: string | null };
}

export class RetrievalRepository {
  constructor(private readonly database: Database.Database = getDatabase()) {}

  resolveBaseIds(options: Pick<RetrievalOptions, "baseIds" | "sessionId"> = {}): string[] {
    let ids = options.baseIds;
    if (options.sessionId) {
      const session = this.database.prepare("SELECT mode FROM sessions WHERE id = ?").get(options.sessionId) as { mode: string } | undefined;
      if (!session) return [];
      const linked = this.database.prepare("SELECT knowledge_base_id FROM session_knowledge_bases WHERE session_id = ? ORDER BY knowledge_base_id").all(options.sessionId) as Array<{ knowledge_base_id: string }>;
      const allowed = session.mode === "INTERVIEWEE" ? [DEFAULT_KNOWLEDGE_BASE_ID]
        : session.mode === "INTERVIEWER" ? [] : linked.length ? linked.map((row) => row.knowledge_base_id) : [DEFAULT_KNOWLEDGE_BASE_ID];
      ids = ids === undefined ? allowed : ids.filter((id) => allowed.includes(id));
    }
    ids ??= [DEFAULT_KNOWLEDGE_BASE_ID];
    if (!ids.length) return [];
    return (this.database.prepare(`SELECT id FROM knowledge_bases WHERE id IN (${ids.map(() => "?").join(",")}) AND status = 'ACTIVE' ORDER BY id`).all(...ids) as Array<{ id: string }>).map((row) => row.id);
  }

  retrieve(query: string, options: RetrievalOptions = {}): RetrievalResult[] {
    const baseIds = this.resolveBaseIds(options);
    if (!baseIds.length) return [];
    const primary = searchTokens(query);
    const hints = primary.length <= 2 ? searchTokens((options.contextHint || "").slice(-4000)) : [];
    if (!primary.length && !hints.length) return [];
    const limit = Math.max(0, Math.min(200, Math.floor(options.limit ?? 20)));
    if (!limit || options.sourceKinds?.length === 0) return [];
    const kinds = options.sourceKinds || ["ENTRY", "DOCUMENT", "QA"];
    const sourceKind = "CASE WHEN item.document_id IS NOT NULL THEN 'DOCUMENT' WHEN entry.kind = 'QA' THEN 'QA' WHEN item.entry_id IS NOT NULL THEN 'ENTRY' WHEN item.question_id IS NOT NULL THEN 'QUESTION' WHEN item.summary_session_id IS NOT NULL THEN 'SUMMARY' ELSE 'TRANSCRIPT' END";
    const scopedBases = baseIds.map(() => "?").join(",");
    const sql = `SELECT item.id, item.title, item.body AS text, bm25(retrieval_fts, 4.0, 1.0, 2.0) AS rank,
      item.token_estimate AS tokenEstimate, ${sourceKind} AS sourceKind,
      COALESCE(item.entry_id, item.document_id, item.question_id, item.summary_session_id, item.transcript_turn_id) AS ownerId,
      base.id AS baseId, COALESCE(item.document_id, entry.document_id) AS documentId,
      item.entry_id AS entryId, item.question_id AS questionId, COALESCE(question.session_id, item.summary_session_id, turn.session_id) AS sessionId,
      item.transcript_turn_id AS turnId, item.chunk_index AS chunkIndex, entry.kind AS entryKind,
      json_extract(document.source_json, '$.id') AS sourceId, CASE WHEN entry.kind = 'QA' THEN json_extract(entry.data_json, '$.id') END AS qaId
      FROM retrieval_fts JOIN retrieval_items item ON item.id = retrieval_fts.rowid
      LEFT JOIN knowledge_entries entry ON entry.id = item.entry_id
      LEFT JOIN knowledge_documents document ON document.id = COALESCE(item.document_id, entry.document_id)
      LEFT JOIN knowledge_bases base ON base.id = COALESCE(entry.knowledge_base_id, document.knowledge_base_id)
      LEFT JOIN questions question ON question.id = item.question_id
      LEFT JOIN transcript_turns turn ON turn.id = item.transcript_turn_id
      LEFT JOIN sessions history ON history.id = COALESCE(question.session_id, item.summary_session_id, turn.session_id)
      WHERE retrieval_fts MATCH ? AND (${sourceKind}) IN (${kinds.map(() => "?").join(",")})
      AND (base.id IN (${scopedBases}) OR history.id = ?)
      AND (entry.id IS NULL OR (entry.enabled = 1 AND entry.review_state = 'APPROVED'))
      ORDER BY rank ASC, ownerId ASC, item.chunk_index ASC LIMIT ?`;
    const statement = this.database.prepare(sql);
    const fetch = (tokens: string[], operator: string) => statement.all(tokens.map((token) => `"${token}"`).join(` ${operator} `), ...kinds, ...baseIds, options.sessionId || null, limit) as Array<Omit<RetrievalResult, "id" | "provenance"> & RetrievalResult["provenance"] & { id: number }>;
    let rows = primary.length ? fetch(primary, "AND") : [];
    if (!rows.length) rows = fetch([...new Set([...primary, ...hints])], "OR");
    const results: RetrievalResult[] = [];
    let remaining = Math.max(0, options.tokenBudget ?? 6000);
    for (const row of rows) {
      if (row.tokenEstimate > remaining) continue;
      remaining -= row.tokenEstimate;
      results.push({ id: `retrieval:${JSON.stringify([row.sourceKind, row.ownerId, row.chunkIndex])}`, ownerId: row.ownerId, title: row.title, text: row.text, rank: row.rank, tokenEstimate: row.tokenEstimate, sourceKind: row.sourceKind,
        provenance: { baseId: row.baseId, documentId: row.documentId, entryId: row.entryId, questionId: row.questionId, sessionId: row.sessionId, turnId: row.turnId, chunkIndex: row.chunkIndex, entryKind: row.entryKind, sourceId: row.sourceId, qaId: row.qaId } });
    }
    return results;
  }
}