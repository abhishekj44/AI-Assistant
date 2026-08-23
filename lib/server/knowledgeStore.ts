import fs from "node:fs/promises";
import path from "node:path";
import {
  EMPTY_KNOWLEDGE_PACK,
  type CandidateExperience,
  type CandidateKnowledgePack,
  type CandidateProject,
  type KnowledgeContribution,
  type KnowledgeSource,
} from "@/lib/knowledge/types";

const DATA_DIR = path.join(process.cwd(), "data");
const PACK_PATH = path.join(DATA_DIR, "candidate-knowledge.json");

let cachedPack: CandidateKnowledgePack | null = null;
let cachedPackMtimeMs = -1;
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

export async function readKnowledgePackWithMeta(): Promise<KnowledgePackReadResult> {
  try {
    const stat = await fs.stat(PACK_PATH);
    if (cachedPack && cachedPackMtimeMs === stat.mtimeMs) {
      lastReadWasCacheHit = true;
      return { pack: cachedPack, cacheHit: true };
    }

    const raw = await fs.readFile(PACK_PATH, "utf8");
    const parsed = JSON.parse(raw) as CandidateKnowledgePack;
    if (!parsed || !Array.isArray(parsed.sources)) throw new Error("Invalid knowledge pack format");
    cachedPack = parsed;
    cachedPackMtimeMs = stat.mtimeMs;
    lastReadWasCacheHit = false;
    return { pack: parsed, cacheHit: false };
  } catch (error: any) {
    if (error?.code !== "ENOENT") console.warn("[knowledge] failed to read pack, using empty pack:", error?.message);
    const empty = { ...EMPTY_KNOWLEDGE_PACK, updatedAt: new Date(0).toISOString() };
    cachedPack = empty;
    cachedPackMtimeMs = -1;
    lastReadWasCacheHit = false;
    return { pack: empty, cacheHit: false };
  }
}

export async function readKnowledgePack(): Promise<CandidateKnowledgePack> {
  return (await readKnowledgePackWithMeta()).pack;
}

export function wasLastKnowledgeReadCacheHit(): boolean {
  return lastReadWasCacheHit;
}

export async function writeKnowledgePack(pack: CandidateKnowledgePack): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempPath = `${PACK_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(pack, null, 2), "utf8");
  await fs.rename(tempPath, PACK_PATH);
  const stat = await fs.stat(PACK_PATH);
  cachedPack = pack;
  cachedPackMtimeMs = stat.mtimeMs;
  lastReadWasCacheHit = true;
}


export async function replaceKnowledgePack(pack: CandidateKnowledgePack): Promise<CandidateKnowledgePack> {
  const normalized: CandidateKnowledgePack = {
    ...pack,
    version: Math.max(2, Number(pack.version) || 2),
    updatedAt: new Date().toISOString(),
    profile: pack.profile || { strengths: [] },
    experience: Array.isArray(pack.experience) ? pack.experience : [],
    projects: mergeProjects(Array.isArray(pack.projects) ? pack.projects : []),
    skills: uniqueStrings(Array.isArray(pack.skills) ? pack.skills : []),
    achievements: uniqueStrings(Array.isArray(pack.achievements) ? pack.achievements : []),
    facts: uniqueStrings(Array.isArray(pack.facts) ? pack.facts : []),
    sources: Array.isArray(pack.sources) ? pack.sources : [],
  };
  await writeKnowledgePack(normalized);
  return normalized;
}

export async function addKnowledgeSource(source: KnowledgeSource): Promise<CandidateKnowledgePack> {
  const current = await readKnowledgePack();
  // Replace a document with the same type/name to avoid stale duplicated facts.
  const remaining = current.sources.filter(
    (item) => !(item.filename.toLowerCase() === source.filename.toLowerCase() && item.type === source.type),
  );
  const pack = rebuildPackFromSources([...remaining, source]);
  await writeKnowledgePack(pack);
  return pack;
}

export async function deleteKnowledgeSource(sourceId: string): Promise<CandidateKnowledgePack> {
  const current = await readKnowledgePack();
  const nextSources = current.sources.filter((source) => source.id !== sourceId);
  if (nextSources.length === current.sources.length) throw new Error("Knowledge source not found");
  const pack = rebuildPackFromSources(nextSources);
  await writeKnowledgePack(pack);
  return pack;
}

export async function clearKnowledgePack(): Promise<CandidateKnowledgePack> {
  const empty = { ...EMPTY_KNOWLEDGE_PACK, updatedAt: new Date().toISOString() };
  await writeKnowledgePack(empty);
  return empty;
}
