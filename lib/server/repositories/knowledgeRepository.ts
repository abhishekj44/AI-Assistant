import type Database from "better-sqlite3";
import crypto from "node:crypto";
import { EMPTY_KNOWLEDGE_PACK, type CandidateKnowledgePack, type KnowledgeSource } from "../../knowledge/types";
import { getDatabase } from "../db/connection";
import { DEFAULT_KNOWLEDGE_BASE_ID } from "../db/migrations";
import { assemblePack, independentBaseline, knowledgeRecords, sourcePack } from "../retrieval/knowledgePack";
import { indexContent } from "../retrieval/indexing";

export interface KnowledgeDocumentData { bytes?: Buffer; mimeType?: string; text?: string }
interface StoredPack { format: "knowledge-v1"; importedPack: CandidateKnowledgePack; baseline: CandidateKnowledgePack; pack: CandidateKnowledgePack }

export class KnowledgeRepository {
  constructor(private readonly database: Database.Database = getDatabase()) {}

  getPack(baseId = DEFAULT_KNOWLEDGE_BASE_ID): CandidateKnowledgePack {
    const row = this.database.prepare("SELECT baseline_json FROM knowledge_bases WHERE id = ?").get(baseId) as { baseline_json: string } | undefined;
    if (!row) throw new Error("Knowledge base not found");
    const stored = JSON.parse(row.baseline_json);
    return { ...structuredClone(EMPTY_KNOWLEDGE_PACK), ...(stored.format === "knowledge-v1" ? stored.pack : stored) };
  }

  replacePack(pack: CandidateKnowledgePack, baseId = DEFAULT_KNOWLEDGE_BASE_ID, preserveTimestamps = false): CandidateKnowledgePack {
    const next = { ...structuredClone(pack), updatedAt: preserveTimestamps ? pack.updatedAt : new Date().toISOString() };
    if (Buffer.byteLength(JSON.stringify(pack)) > 12 * 1024 * 1024) throw new Error("Knowledge pack exceeds the 12 MB import limit");
    this.database.transaction(() => {
      this.getPack(baseId);
      const originals = this.database.prepare("SELECT id, original_bytes, mime_type, extracted_text FROM knowledge_documents WHERE knowledge_base_id = ?").all(baseId) as Array<{ id: string; original_bytes: Buffer | null; mime_type: string | null; extracted_text: string }>;
      this.database.prepare("DELETE FROM knowledge_entries WHERE knowledge_base_id = ? AND kind != 'QA'").run(baseId);
      this.database.prepare("DELETE FROM knowledge_documents WHERE knowledge_base_id = ?").run(baseId);
      for (const source of next.sources) {
        const original = originals.find((document) => document.id === this.documentId(source.id, baseId));
        this.saveDocument(source, baseId, original ? { bytes: original.original_bytes ?? undefined, mimeType: original.mime_type ?? undefined, text: original.extracted_text } : undefined);
      }
      this.save({ format: "knowledge-v1", importedPack: next, baseline: independentBaseline(next), pack: next }, baseId);
    })();
    return next;
  }

  addSource(source: KnowledgeSource, baseId = DEFAULT_KNOWLEDGE_BASE_ID, documentData?: KnowledgeDocumentData): CandidateKnowledgePack {
    return this.database.transaction(() => {
      const stored = this.stored(baseId);
      const replacingResume = baseId === DEFAULT_KNOWLEDGE_BASE_ID && source.type === "resume";
      const remaining = stored.pack.sources.filter((item) => !(item.type === source.type
        && (replacingResume || item.filename.toLowerCase() === source.filename.toLowerCase())) && item.id !== source.id);
      for (const old of stored.pack.sources) if (!remaining.some((item) => item.id === old.id)) this.database.prepare("DELETE FROM knowledge_documents WHERE id = ? AND knowledge_base_id = ?").run(this.documentId(old.id, baseId), baseId);
      this.saveDocument(source, baseId, documentData);
      stored.pack = assemblePack(stored.baseline, [...remaining, source]);
      this.save(stored, baseId);
      return stored.pack;
    })();
  }

  deleteSource(id: string, baseId = DEFAULT_KNOWLEDGE_BASE_ID): CandidateKnowledgePack {
    return this.database.transaction(() => {
      const stored = this.stored(baseId);
      const sources = stored.pack.sources.filter((source) => source.id !== id);
      if (sources.length === stored.pack.sources.length) throw new Error("Knowledge source not found");
      this.database.prepare("DELETE FROM knowledge_documents WHERE id = ? AND knowledge_base_id = ?").run(this.documentId(id, baseId), baseId);
      stored.pack = assemblePack(stored.baseline, sources);
      this.save(stored, baseId);
      return stored.pack;
    })();
  }

  clear(baseId = DEFAULT_KNOWLEDGE_BASE_ID): CandidateKnowledgePack {
    return this.replacePack(structuredClone(EMPTY_KNOWLEDGE_PACK), baseId);
  }

  revision(baseId = DEFAULT_KNOWLEDGE_BASE_ID): number {
    const row = this.database.prepare("SELECT revision FROM knowledge_bases WHERE id = ?").get(baseId) as { revision: number } | undefined;
    if (!row) throw new Error("Knowledge base not found");
    return row.revision;
  }

  hasData(baseId = DEFAULT_KNOWLEDGE_BASE_ID): boolean {
    const pack = this.getPack(baseId);
    return pack.sources.length > 0 || knowledgeRecords(pack).length > 0 || Object.keys(pack).some((key) => !(key in EMPTY_KNOWLEDGE_PACK));
  }

  private stored(baseId: string): StoredPack {
    const pack = this.getPack(baseId);
    const row = this.database.prepare("SELECT baseline_json FROM knowledge_bases WHERE id = ?").get(baseId) as { baseline_json: string };
    const stored = JSON.parse(row.baseline_json);
    return stored.format === "knowledge-v1" ? stored : { format: "knowledge-v1", importedPack: pack, baseline: independentBaseline(pack), pack };
  }

  private documentId(id: string, baseId: string): string {
    return `document:${JSON.stringify([baseId, id])}`;
  }

  private saveDocument(source: KnowledgeSource, baseId: string, data?: KnowledgeDocumentData): void {
    const id = this.documentId(source.id, baseId);
    const text = data?.text ?? source.rawExcerpt ?? "";
    const hash = crypto.createHash("sha256").update(data?.bytes ?? text).digest("hex");
    this.database.prepare("INSERT INTO knowledge_documents(id, knowledge_base_id, document_type, filename, content_hash, original_bytes, mime_type, extracted_text, source_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, baseId, source.type, source.filename, hash, data?.bytes ?? null, data?.mimeType ?? null, text, JSON.stringify(source), source.uploadedAt || new Date().toISOString());
    indexContent(this.database, "document_id", id, source.filename, [text, source.summary, ...(source.facts || []), ...(source.keywords || [])].join("\n"));
  }

  private save(stored: StoredPack, baseId: string): void {
    this.database.prepare("DELETE FROM knowledge_entries WHERE knowledge_base_id = ? AND kind != 'QA'").run(baseId);
    const insert = this.database.prepare("INSERT INTO knowledge_entries(id, knowledge_base_id, document_id, kind, title, content, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const sourceRecords = stored.pack.sources.map((source) => ({ source, records: knowledgeRecords(sourcePack([source])) }));
    for (const record of knowledgeRecords(stored.pack)) {
      const key = `${record.kind}:${record.title}`;
      const id = `knowledge:${JSON.stringify([baseId, key])}`;
      const source = sourceRecords.find((item) => item.records.some((candidate) => candidate.kind === record.kind && candidate.title === record.title))?.source;
      const text = typeof record.data === "string" ? record.data : JSON.stringify(record.data);
      insert.run(id, baseId, source ? this.documentId(source.id, baseId) : null, record.kind, record.title, text, JSON.stringify(record.data), source?.uploadedAt || stored.pack.updatedAt, stored.pack.updatedAt);
      indexContent(this.database, "entry_id", id, record.title, text);
    }
    this.database.prepare("UPDATE knowledge_bases SET baseline_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?").run(JSON.stringify(stored), stored.pack.updatedAt, baseId);
  }
}