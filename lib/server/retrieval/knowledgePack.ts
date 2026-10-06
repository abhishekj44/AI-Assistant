import { EMPTY_KNOWLEDGE_PACK, type CandidateKnowledgePack, type KnowledgeSource } from "../../knowledge/types";

function identity(value: unknown): string {
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (item.name) return `name:${String(item.name).toLowerCase()}`;
    if (item.company || item.role) return `experience:${item.company || ""}|${item.role || ""}|${item.period || ""}`.toLowerCase();
  }
  return JSON.stringify(value);
}

function subtract(value: unknown, contribution: unknown): unknown {
  if (JSON.stringify(value) === JSON.stringify(contribution)) return undefined;
  if (Array.isArray(value)) {
    const others = Array.isArray(contribution) ? contribution : [];
    return value.map((item) => {
      const match = others.find((other) => identity(other) === identity(item));
      return match === undefined ? item : subtract(item, match);
    }).filter((item) => item !== undefined);
  }
  if (value && contribution && typeof value === "object" && typeof contribution === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const remaining = subtract(item, (contribution as Record<string, unknown>)[key]);
      if (remaining !== undefined) result[key] = remaining;
    }
    if (Object.keys(result).length && "name" in value) result.name = (value as { name: string }).name;
    if (Object.keys(result).length && ("company" in value || "role" in value)) {
      for (const key of ["company", "role", "period"]) if (key in value) result[key] = (value as Record<string, unknown>)[key];
    }
    return Object.keys(result).length ? result : undefined;
  }
  return value;
}

function merge(left: unknown, right: unknown): any {
  if (right === undefined) return left;
  if (Array.isArray(left) && Array.isArray(right)) {
    const items = new Map(left.map((item) => [identity(item), item]));
    for (const item of right) items.set(identity(item), items.has(identity(item)) ? merge(items.get(identity(item)), item) : item);
    return [...items.values()];
  }
  if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
    const result = { ...left } as Record<string, unknown>;
    for (const [key, value] of Object.entries(right)) result[key] = merge(result[key], value);
    return result;
  }
  return right;
}

export function sourcePack(sources: KnowledgeSource[]): CandidateKnowledgePack {
  let pack = structuredClone(EMPTY_KNOWLEDGE_PACK);
  for (const source of sources) {
    pack = merge(pack, source.contribution || {});
    pack.facts = merge(pack.facts, source.facts || []);
  }
  return { ...pack, sources };
}

export function independentBaseline(pack: CandidateKnowledgePack): CandidateKnowledgePack {
  const remaining = subtract(pack, sourcePack(pack.sources)) as Partial<CandidateKnowledgePack> | undefined;
  return { ...structuredClone(EMPTY_KNOWLEDGE_PACK), ...remaining, sources: [] };
}

export function assemblePack(baseline: CandidateKnowledgePack, sources: KnowledgeSource[]): CandidateKnowledgePack {
  const pack = { ...merge(sourcePack(sources), baseline), sources, updatedAt: new Date().toISOString() } as CandidateKnowledgePack;
  pack.projects = pack.projects.map((project) => ({ ...project, technologies: project.technologies ?? [], decisions: project.decisions ?? [], challenges: project.challenges ?? [], metrics: project.metrics ?? [], lessons: project.lessons ?? [] }));
  pack.experience = pack.experience.map((experience) => ({ ...experience, responsibilities: experience.responsibilities ?? [], achievements: experience.achievements ?? [], technologies: experience.technologies ?? [] }));
  return pack;
}

export function knowledgeRecords(pack: CandidateKnowledgePack): Array<{ kind: string; title: string; data: unknown }> {
  const records = [
    { kind: "PROFILE", title: pack.profile.headline || "Personal profile", data: pack.profile },
    ...(pack.targetRole ? [{ kind: "TARGET_ROLE", title: pack.targetRole.title || "Target role", data: pack.targetRole }] : []),
    ...pack.experience.map((data) => ({ kind: "EXPERIENCE", title: `${data.company || ""} ${data.role || ""}`.trim(), data })),
    ...pack.projects.map((data) => ({ kind: "PROJECT", title: data.name, data })),
    ...(["skills", "achievements", "facts"] as const).flatMap((key) => pack[key].map((data) => ({ kind: { skills: "SKILL", achievements: "ACHIEVEMENT", facts: "FACT" }[key], title: data, data }))),
  ].filter((record) => JSON.stringify(record.data) !== '{"strengths":[]}');
  return [...new Map(records.map((record) => [`${record.kind}:${record.title}`, record])).values()];
}