import { getDatabase } from "./db/connection";
import { DEFAULT_KNOWLEDGE_BASE_ID } from "./db/migrations";
import { knowledgeBaseRepository } from "./repositories/knowledgeBaseRepository";
import { KnowledgeRepository, type KnowledgeDocumentData } from "./repositories/knowledgeRepository";
import {
  EMPTY_KNOWLEDGE_PACK,
  type CandidateExperience,
  type CandidateKnowledgePack,
  type CandidateProject,
  type KnowledgeContribution,
  type KnowledgeSource,
} from "@/lib/knowledge/types";

let cachedPack: CandidateKnowledgePack | null = null;
let cachedRevision = -1;
let cachedBaseId = "";
let cachedDatabase: ReturnType<typeof getDatabase> | null = null;
let lastReadWasCacheHit = false;

function uniqueStrings(items: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const normalized = item?.trim();
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function mergeExperience(items: CandidateExperience[]): CandidateExperience[] {
  const map = new Map<string, CandidateExperience>();
  for (const item of items) {
    const key = `${item.company || ""}|${item.role || ""}|${item.period || ""}`.toLowerCase();
    const previous = map.get(key);
    if (!previous) {
      map.set(key, {
        company: item.company,
        role: item.role,
        period: item.period,
        responsibilities: uniqueStrings(item.responsibilities || []),
        achievements: uniqueStrings(item.achievements || []),
        technologies: uniqueStrings(item.technologies || []),
      });
    } else {
      previous.responsibilities = uniqueStrings([...previous.responsibilities, ...(item.responsibilities || [])]);
      previous.achievements = uniqueStrings([...previous.achievements, ...(item.achievements || [])]);
      previous.technologies = uniqueStrings([...previous.technologies, ...(item.technologies || [])]);
    }
  }
  return [...map.values()];
}

function mergeProjects(items: CandidateProject[]): CandidateProject[] {
  const map = new Map<string, CandidateProject>();
  for (const item of items) {
    if (!item.name?.trim()) continue;
    const key = item.name.trim().toLowerCase();
    const previous = map.get(key);
    if (!previous) {
      map.set(key, {
        name: item.name.trim(),
        problem: item.problem,
        role: item.role,
        architecture: item.architecture,
        technologies: uniqueStrings(item.technologies || []),
        decisions: item.decisions || [],
        challenges: item.challenges || [],
        metrics: uniqueStrings(item.metrics || []),
        lessons: uniqueStrings(item.lessons || []),
        answerHooks: uniqueStrings(item.answerHooks || []),
        examples: (item.examples || []).slice(0, 8),
      });
    } else {
      previous.problem ||= item.problem;
      previous.role ||= item.role;
      previous.architecture ||= item.architecture;
      previous.technologies = uniqueStrings([...previous.technologies, ...(item.technologies || [])]);
      previous.metrics = uniqueStrings([...previous.metrics, ...(item.metrics || [])]);
      previous.lessons = uniqueStrings([...previous.lessons, ...(item.lessons || [])]);
      previous.answerHooks = uniqueStrings([...(previous.answerHooks || []), ...(item.answerHooks || [])]);
      const exampleMap = new Map<string, NonNullable<CandidateProject["examples"]>[number]>();
      for (const example of [...(previous.examples || []), ...(item.examples || [])]) {
        if (!example?.title?.trim()) continue;
        exampleMap.set(example.title.trim().toLowerCase(), example);
      }
      previous.examples = [...exampleMap.values()].slice(0, 8);
      previous.decisions = [...previous.decisions, ...(item.decisions || [])].slice(0, 20);
      previous.challenges = [...previous.challenges, ...(item.challenges || [])].slice(0, 20);
    }
  }
  return [...map.values()];
}

export function rebuildPackFromSources(sources: KnowledgeSource[]): CandidateKnowledgePack {
  const contributions = sources.map((source) => source.contribution).filter(Boolean) as KnowledgeContribution[];
  const profiles = contributions.map((c) => c.profile).filter(Boolean);
  const targetRoles = contributions.map((c) => c.targetRole).filter(Boolean);
  const mostRecentProfile = [...profiles].reverse().find((p) => p?.summary || p?.headline);
  const mostRecentTarget = [...targetRoles].reverse().find((t) => t?.title || t?.requirements?.length);

  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    profile: {
      headline: mostRecentProfile?.headline,
      summary: mostRecentProfile?.summary,
      strengths: uniqueStrings(profiles.flatMap((p) => p?.strengths || [])),
    },
    targetRole: mostRecentTarget
      ? {
          title: mostRecentTarget.title,
          company: mostRecentTarget.company,
          priorities: uniqueStrings(targetRoles.flatMap((t) => t?.priorities || [])),
          requirements: uniqueStrings(targetRoles.flatMap((t) => t?.requirements || [])),
        }
      : undefined,
    experience: mergeExperience(contributions.flatMap((c) => c.experience || [])),
    projects: mergeProjects(contributions.flatMap((c) => c.projects || [])),
    skills: uniqueStrings(contributions.flatMap((c) => c.skills || [])),
    achievements: uniqueStrings(contributions.flatMap((c) => c.achievements || [])),
    facts: uniqueStrings([
      ...contributions.flatMap((c) => c.facts || []),
      ...sources.flatMap((source) => source.facts || []),
    ]),
    sources,
  };
}

export interface KnowledgePackReadResult {
  pack: CandidateKnowledgePack;
  cacheHit: boolean;
}

export async function readKnowledgePackWithMeta(baseId = DEFAULT_KNOWLEDGE_BASE_ID): Promise<KnowledgePackReadResult> {
  knowledgeBaseRepository.require(baseId);
  const database = getDatabase();
  const repository = new KnowledgeRepository(database);
  const revision = repository.revision(baseId);
  lastReadWasCacheHit = cachedDatabase === database && cachedBaseId === baseId && cachedRevision === revision && cachedPack !== null;
  if (!lastReadWasCacheHit) cachedPack = repository.getPack(baseId);
  cachedBaseId = baseId;
  cachedDatabase = database;
  cachedRevision = revision;
  return { pack: structuredClone(cachedPack!), cacheHit: lastReadWasCacheHit };
}

export async function readKnowledgePack(baseId = DEFAULT_KNOWLEDGE_BASE_ID): Promise<CandidateKnowledgePack> {
  return (await readKnowledgePackWithMeta(baseId)).pack;
}

export function wasLastKnowledgeReadCacheHit(): boolean {
  return lastReadWasCacheHit;
}

export async function writeKnowledgePack(pack: CandidateKnowledgePack, baseId = DEFAULT_KNOWLEDGE_BASE_ID): Promise<void> {
  knowledgeBaseRepository.require(baseId);
  new KnowledgeRepository().replacePack(pack, baseId, true);
}


export async function replaceKnowledgePack(pack: CandidateKnowledgePack, baseId = DEFAULT_KNOWLEDGE_BASE_ID): Promise<CandidateKnowledgePack> {
  knowledgeBaseRepository.require(baseId);
  return new KnowledgeRepository().replacePack(pack, baseId);
}

export async function addKnowledgeSource(source: KnowledgeSource, documentData?: KnowledgeDocumentData, baseId = DEFAULT_KNOWLEDGE_BASE_ID): Promise<CandidateKnowledgePack> {
  knowledgeBaseRepository.require(baseId);
  return new KnowledgeRepository().addSource(source, baseId, documentData);
}

export async function deleteKnowledgeSource(sourceId: string, baseId = DEFAULT_KNOWLEDGE_BASE_ID): Promise<CandidateKnowledgePack> {
  knowledgeBaseRepository.require(baseId);
  return new KnowledgeRepository().deleteSource(sourceId, baseId);
}

export async function clearKnowledgePack(baseId = DEFAULT_KNOWLEDGE_BASE_ID): Promise<CandidateKnowledgePack> {
  knowledgeBaseRepository.require(baseId);
  return new KnowledgeRepository().clear(baseId);
}
