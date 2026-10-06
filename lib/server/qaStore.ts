import type { QABank } from "@/lib/qa/types";
import { getDatabase } from "./db/connection";
import { DEFAULT_KNOWLEDGE_BASE_ID } from "./db/migrations";
import { knowledgeBaseRepository } from "./repositories/knowledgeBaseRepository";
import { AnswerLibraryRepository } from "./repositories/answerLibraryRepository";
import { KnowledgeRepository } from "./repositories/knowledgeRepository";
export { cleanString, sanitizeQAEntry } from "./retrieval/qaSanitization";

let cachedBank: QABank | null = null;
let cachedRevision = -1;
let cachedBaseId = "";
let cachedDatabase: ReturnType<typeof getDatabase> | null = null;

export interface QABankReadResult {
  bank: QABank;
  cacheHit: boolean;
}

export async function readQABankWithMeta(baseId = DEFAULT_KNOWLEDGE_BASE_ID): Promise<QABankReadResult> {
  knowledgeBaseRepository.require(baseId);
  const database = getDatabase();
  const revision = new KnowledgeRepository(database).revision(baseId);
  const cacheHit = cachedDatabase === database && cachedBaseId === baseId && cachedRevision === revision && cachedBank !== null;
  if (!cacheHit) cachedBank = new AnswerLibraryRepository(database).readBank(baseId);
  cachedBaseId = baseId;
  cachedDatabase = database;
  cachedRevision = revision;
  return { bank: structuredClone(cachedBank!), cacheHit };
}

export async function readQABank(baseId = DEFAULT_KNOWLEDGE_BASE_ID): Promise<QABank> {
  return (await readQABankWithMeta(baseId)).bank;
}

export async function upsertQAEntry(value: unknown, baseId = DEFAULT_KNOWLEDGE_BASE_ID): Promise<QABank> {
  knowledgeBaseRepository.require(baseId);
  return new AnswerLibraryRepository().upsertQA(value, baseId);
}

export async function deleteQAEntry(id: string, baseId = DEFAULT_KNOWLEDGE_BASE_ID): Promise<QABank> {
  knowledgeBaseRepository.require(baseId);
  return new AnswerLibraryRepository().deleteQA(id, baseId);
}

export async function clearQABank(baseId = DEFAULT_KNOWLEDGE_BASE_ID): Promise<QABank> {
  knowledgeBaseRepository.require(baseId);
  return new AnswerLibraryRepository().clearQA(baseId);
}

export async function importQABank(value: unknown, mode: "merge" | "replace" = "merge", baseId = DEFAULT_KNOWLEDGE_BASE_ID): Promise<QABank> {
  knowledgeBaseRepository.require(baseId);
  return new AnswerLibraryRepository().importBank(value, mode, baseId);
}
