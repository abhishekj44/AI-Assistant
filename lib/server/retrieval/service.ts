import type Database from "better-sqlite3";
import { EMPTY_KNOWLEDGE_PACK, type CandidateKnowledgePack } from "../../knowledge/types";
import { selectCandidateContextWithMeta } from "../../knowledge/contextSelector";
import { EMPTY_QA_BANK, type QABank } from "../../qa/types";
import { selectQAMatches } from "../../qa/qaSelector";
import { getDatabase } from "../db/connection";
import { KnowledgeRepository } from "../repositories/knowledgeRepository";
import { AnswerLibraryRepository } from "../repositories/answerLibraryRepository";
import { RetrievalRepository, type RetrievalResult } from "../repositories/retrievalRepository";
import { lexicalAliases, normalizeSearch } from "./normalization";
import { assemblePack } from "./knowledgePack";

export interface ContextOptions { sessionId?: string; callType?: string; baseIds?: string[] }
export interface RetrievedContext { pack: CandidateKnowledgePack; bank: QABank; meta: { engine: string; elapsedMs: number; items: RetrievalResult[] } }

export function documentEvidence(items: RetrievalResult[], maxChars = 1800): string {
  const selected: Array<{ source: string; text: string }> = [];
  const seen = new Set<string>();
  let used = 0;
  for (const item of items) {
    if (item.sourceKind !== "DOCUMENT" || seen.has(item.ownerId) || selected.length >= 3) continue;
    const text = item.text.slice(0, Math.min(700, maxChars - used));
    if (text.length < 20) continue;
    selected.push({ source: item.title, text });
    used += text.length;
    seen.add(item.ownerId);
  }
  return selected.length ? JSON.stringify(selected) : "";
}

export function createRetrievalService(database: Database.Database): (query: string, contextHint: string, options?: ContextOptions) => Promise<RetrievedContext> {
  const knowledge = new KnowledgeRepository(database);
  const answers = new AnswerLibraryRepository(database);
  const retrieval = new RetrievalRepository(database);
  const cache = new Map<string, { revision: number; pack: CandidateKnowledgePack; bank: QABank }>();
  return async (query, contextHint, options = {}) => {
    const started = performance.now();
    const baseIds = retrieval.resolveBaseIds(options);
    let pack = structuredClone(EMPTY_KNOWLEDGE_PACK);
    let bank = structuredClone(EMPTY_QA_BANK);
    const sources: CandidateKnowledgePack["sources"] = [];
    for (const baseId of baseIds) {
      const revision = knowledge.revision(baseId);
      let stored = cache.get(baseId);
      if (!stored || stored.revision !== revision) {
        stored = { revision, pack: knowledge.getPack(baseId), bank: answers.readBank(baseId) };
        cache.set(baseId, stored);
        if (cache.size > 24) cache.delete(cache.keys().next().value!);
      }
      pack = assemblePack(pack, [{ id: baseId, filename: baseId, type: "other", uploadedAt: stored.pack.updatedAt, summary: "", facts: [], keywords: [], contribution: stored.pack }]);
      sources.push(...stored.pack.sources);
      pack.sources = sources;
      bank.entries.push(...structuredClone(stored.bank.entries));
      bank.updatedAt = stored.bank.updatedAt;
    }
    const items = retrieval.retrieve(query, { ...options, contextHint, limit: 40, sourceKinds: ["ENTRY", "DOCUMENT", "QA"], tokenBudget: 12000 });
    const aliases = `${query} ${lexicalAliases(query)}`;
    const hintAliases = `${contextHint} ${lexicalAliases(contextHint)}`;
    const lexical = selectCandidateContextWithMeta(pack, aliases, hintAliases);
    const titles = new Set(items.filter((item) => item.sourceKind === "ENTRY").map((item) => item.title));
    const sourceIds = new Set(items.map((item) => item.provenance.sourceId).filter(Boolean));
    const broad = lexical.broadPersonalQuestion;
    const selectedProjects = new Set(lexical.selectedProjectNames);
    const selectedExperience = new Set(lexical.selectedExperienceLabels);
    if (!broad) {
      pack.projects = pack.projects.filter((project) => titles.has(project.name) || selectedProjects.has(project.name));
      pack.experience = pack.experience.filter((experience) => titles.has(`${experience.company || ""} ${experience.role || ""}`.trim()) || [...selectedExperience].some((label) => label.includes(experience.company || "\u0000") || label.includes(experience.role || "\u0000")));
      pack.sources = pack.sources.filter((source) => sourceIds.has(source.id));
    }
    pack.projects = pack.projects.map((project) => titles.has(project.name)
      ? { ...project, answerHooks: [...(project.answerHooks || []), lexicalAliases(JSON.stringify(project))] }
      : project);
    pack.experience = pack.experience.map((experience) => titles.has(`${experience.company || ""} ${experience.role || ""}`.trim())
      ? { ...experience, technologies: [...new Set([...experience.technologies, ...experience.technologies.flatMap((technology) => lexicalAliases(technology).split(" "))])] }
      : experience);
    const qaIds = new Set(items.filter((item) => item.sourceKind === "QA").map((item) => item.provenance.qaId));
    const lexicalQA = new Set(selectQAMatches(bank, aliases, hintAliases, 5).map((match) => match.entry.id));
    bank.entries = bank.entries.filter((entry) => entry.enabled && (qaIds.has(entry.id) || lexicalQA.has(entry.id))).map((entry) => {
      if (!qaIds.has(entry.id) || selectQAMatches({ ...bank, entries: [entry] }, query, contextHint).length) return entry;
      return { ...entry, questions: [...new Set([...entry.questions, ...entry.questions.map(normalizeSearch), ...entry.questions.map(lexicalAliases)])] };
    });
    return { pack, bank, meta: { engine: "sqlite-fts5+lexical", elapsedMs: performance.now() - started, items } };
  };
}

let serviceDatabase: Database.Database | undefined;
let service: ReturnType<typeof createRetrievalService> | undefined;
export async function retrieveContext(query: string, contextHint: string, options?: ContextOptions): Promise<RetrievedContext> {
  const database = getDatabase();
  if (database !== serviceDatabase || !service) {
    serviceDatabase = database;
    service = createRetrievalService(database);
  }
  return service(query, contextHint, options);
}