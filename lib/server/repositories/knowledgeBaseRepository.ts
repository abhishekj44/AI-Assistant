import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDatabase } from "../db/connection";
import { DEFAULT_KNOWLEDGE_BASE_ID, LOCAL_PROFILE_ID } from "../db/migrations";

export type KnowledgeBaseKind = "PERSONAL" | "JOB" | "REFERENCE";
export interface KnowledgeBase { id: string; name: string; company: string | null; kind: KnowledgeBaseKind }
export class KnowledgeBaseError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export function validateKnowledgeBaseId(value: unknown): string {
  if (typeof value !== "string" || (value !== DEFAULT_KNOWLEDGE_BASE_ID && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) throw new KnowledgeBaseError("Invalid knowledge base id");
  return value;
}

export class KnowledgeBaseRepository {
  constructor(private readonly suppliedDatabase?: Database.Database) {}
  private get database() { return this.suppliedDatabase ?? getDatabase(); }

  list(): KnowledgeBase[] {
    return this.database.prepare("SELECT id,name,company,kind FROM knowledge_bases WHERE status='ACTIVE' AND (profile_id=? OR (profile_id IS NULL AND kind IN ('JOB','REFERENCE'))) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,name,id")
      .all(LOCAL_PROFILE_ID, DEFAULT_KNOWLEDGE_BASE_ID) as KnowledgeBase[];
  }

  require(id: string = DEFAULT_KNOWLEDGE_BASE_ID): KnowledgeBase {
    validateKnowledgeBaseId(id);
    const base = this.database.prepare("SELECT id,name,company,kind FROM knowledge_bases WHERE id=? AND status='ACTIVE' AND (profile_id=? OR (profile_id IS NULL AND kind IN ('JOB','REFERENCE')))")
      .get(id, LOCAL_PROFILE_ID) as KnowledgeBase | undefined;
    if (!base) throw new KnowledgeBaseError("Knowledge base not found or unavailable", 404);
    return base;
  }

  private fields(input: { name: unknown; company?: unknown }) {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 160) throw new KnowledgeBaseError("Name must contain 1 to 160 characters");
    if (input.company != null && (typeof input.company !== "string" || input.company.length > 160)) throw new KnowledgeBaseError("Company must be at most 160 characters");
    return { name: input.name.trim(), company: typeof input.company === "string" ? input.company.trim() || null : null };
  }

  create(input: { name: unknown; company?: unknown; kind: unknown }): KnowledgeBase {
    if (!["PERSONAL", "JOB", "REFERENCE"].includes(input.kind as string)) throw new KnowledgeBaseError("Invalid knowledge base kind");
    const fields = this.fields(input);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare("INSERT INTO knowledge_bases(id,profile_id,kind,name,company,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, input.kind === "PERSONAL" ? LOCAL_PROFILE_ID : null, input.kind, fields.name, fields.company, now, now);
    return this.require(id);
  }

  update(id: string, input: { name: unknown; company?: unknown }): KnowledgeBase {
    this.require(id);
    const fields = this.fields(input);
    this.database.prepare("UPDATE knowledge_bases SET name=?,company=?,updated_at=?,revision=revision+1 WHERE id=?").run(fields.name, fields.company, new Date().toISOString(), id);
    return this.require(id);
  }

  delete(id: string): void {
    this.database.transaction(() => {
      this.require(id);
      if (id === DEFAULT_KNOWLEDGE_BASE_ID) throw new KnowledgeBaseError("The default knowledge base cannot be deleted; clear its knowledge instead", 409);
      if (this.database.prepare("SELECT 1 FROM session_knowledge_bases WHERE knowledge_base_id=? LIMIT 1").get(id)) throw new KnowledgeBaseError("Knowledge base is linked to a session", 409);
      this.database.prepare("DELETE FROM knowledge_entries WHERE knowledge_base_id=?").run(id);
      this.database.prepare("DELETE FROM knowledge_bases WHERE id=?").run(id);
    })();
  }

  validateSelections(value: unknown, mode: string): KnowledgeBase[] {
    if (!Array.isArray(value) || value.length > 20 || (value.length === 0 && mode !== "INTERVIEWER")) throw new KnowledgeBaseError("Select between 1 and 20 knowledge bases (interviewer may select none)");
    const ids = value.map(validateKnowledgeBaseId);
    if (new Set(ids).size !== ids.length) throw new KnowledgeBaseError("Duplicate knowledge base selections");
    return ids.map(id => this.require(id));
  }

  sourceAvailability(baseId = DEFAULT_KNOWLEDGE_BASE_ID): Record<string, boolean> {
    this.require(baseId);
    const rows = this.database.prepare("SELECT json_extract(source_json,'$.id') AS source_id,original_bytes IS NOT NULL AS available FROM knowledge_documents WHERE knowledge_base_id=?").all(baseId) as Array<{ source_id: string; available: number }>;
    return Object.fromEntries(rows.map(row => [row.source_id, Boolean(row.available)]));
  }

  original(baseId: string, sourceId: string): { filename: string; bytes: Buffer; mimeType: string | null } {
    this.require(baseId);
    if (!sourceId || sourceId.length > 512) throw new KnowledgeBaseError("Invalid source id");
    const row = this.database.prepare("SELECT filename,original_bytes AS bytes,mime_type AS mimeType FROM knowledge_documents WHERE knowledge_base_id=? AND json_extract(source_json,'$.id')=?")
      .get(baseId, sourceId) as { filename: string; bytes: Buffer | null; mimeType: string | null } | undefined;
    if (!row?.bytes) throw new KnowledgeBaseError("Original file is unavailable for this source (older imports may not contain file bytes)", 404);
    return { ...row, bytes: row.bytes };
  }
}

export const knowledgeBaseRepository = new KnowledgeBaseRepository();