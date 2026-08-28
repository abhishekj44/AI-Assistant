import type {
  CandidateExperience,
  CandidateKnowledgePack,
  CandidateProject,
  CandidateProjectExample,
} from "./types";

const STOP_WORDS = new Set([
  "the", "and", "that", "this", "with", "from", "have", "your", "what", "when", "where",
  "which", "would", "could", "should", "about", "into", "there", "their", "they", "were", "been",
  "then", "than", "also", "just", "using", "used", "tell", "explain", "describe", "you", "how",
  "did", "does", "why", "can", "for", "are", "was", "our", "out", "get", "got", "me", "my",
  "like", "basically", "whatever", "wanted", "want", "given", "apply", "sir",
]);

const BROAD_PERSONAL_PATTERN = /\b(tell me about yourself|walk me through|background|career|resume|cv|your experience|your role|your project|projects|worked on|work experience|biggest challenge|strengths?|achievement|leadership|team|responsibilit|what did you build)\b/i;
const DECISION_PATTERN = /\b(why|choose|chose|decision|tradeoff|trade-off|instead|architecture|design|approach)\b/i;
const CHALLENGE_PATTERN = /\b(challenge|problem|issue|difficult|failure|fail|resolve|solve|overcome)\b/i;
const METRIC_PATTERN = /\b(metric|scale|scalability|latency|throughput|performance|users?|accuracy|improve|reduc|percent|%)\b/i;
const LESSON_PATTERN = /\b(learn|lesson|improve|change|different|again|rebuild|next time|retrospective)\b/i;
const SCENARIO_PATTERN = /\b(customer|scenario|given you|how would|you have to|solve|solution|architect|architecture|design|approach|pipeline|deploy|integration|integrate|worker|agent|vlm|vision|multimodal|model|trade-?off)\b/i;
const EXAMPLE_PATTERN = /\b(example|use case|project|experience|similar|previously|before|worked on|implemented|built|designed|architected)\b/i;
const OVERVIEW_PATTERN = /\b(tell me about yourself|walk me through (?:your )?(?:background|career|resume|experience)|career overview|work experience|resume|cv)\b/i;

export interface CandidateContextSelection {
  context: string;
  rawChars: number;
  selectedChars: number;
  budgetChars: number;
  compressionRatio: number | null;
  selectedProjectNames: string[];
  selectedExperienceLabels: string[];
  broadPersonalQuestion: boolean;
  topProjectName?: string;
  topProjectScore?: number;
  projectEvidenceRequired: boolean;
  projectExampleIncluded: boolean;
  selectedExampleTitles: string[];
  evidenceStrategy: "project_capsule" | "broad_profile" | "technical_core";
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/retrieval[\s-]?augmented[\s-]?generation/g, "rag")
    .replace(/fine[\s-]?tun(?:e|ing|ed)/g, "finetune")
    .replace(/vision[\s-]?language[\s-]?models?/g, "vlm")
    .replace(/multi[\s-]?modal/g, "multimodal")
    .replace(/object[\s-]?detection/g, "objectdetection")
    .replace(/computer[\s-]?vision/g, "computervision")
    .replace(/[^a-z0-9+#./-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  return Array.from(
    new Set(
      normalize(text)
        .split(/\s+/)
        .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
    ),
  );
}

function scoreText(text: string | undefined, queryTokens: string[]): number {
  if (!text || queryTokens.length === 0) return 0;
  const lower = normalize(text);
  let score = 0;
  for (const token of queryTokens) {
    if (!lower.includes(token)) continue;
    score += token.length >= 9 ? 3 : token.length >= 6 ? 2 : 1;
  }
  return score;
}

function clipText(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const clean = value.trim();
  if (!clean) return undefined;
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function rankStrings(items: string[], queryTokens: string[], max: number, fallback = 0): string[] {
  const ranked = items
    .map((value) => ({ value, score: scoreText(value, queryTokens) }))
    .sort((a, b) => b.score - a.score);
  const relevant = ranked.filter((item) => item.score > 0).slice(0, max).map((item) => item.value);
  if (relevant.length > 0) return relevant;
  return fallback > 0 ? items.slice(0, Math.min(fallback, max)) : [];
}

function exampleSearchText(example: CandidateProjectExample): string {
  return [example.title, example.situation, example.approach, example.result, ...(example.relevance || [])]
    .filter(Boolean)
    .join(" ");
}

function projectSearchText(project: CandidateProject): string {
  return [
    project.name,
    project.problem,
    project.role,
    project.architecture,
    ...project.technologies,
    ...project.metrics,
    ...project.lessons,
    ...(project.answerHooks || []),
    ...(project.examples || []).map(exampleSearchText),
    ...project.decisions.flatMap((decision) => [decision.decision, decision.reason, ...(decision.tradeoffs || [])]),
    ...project.challenges.flatMap((challenge) => [challenge.challenge, challenge.solution, challenge.result]),
  ]
    .filter(Boolean)
    .join(" ");
}

function experienceSearchText(experience: CandidateExperience): string {
  return [
    experience.company,
    experience.role,
    experience.period,
    ...experience.responsibilities,
    ...experience.achievements,
    ...experience.technologies,
  ]
    .filter(Boolean)
    .join(" ");
}

function scoreProject(project: CandidateProject, primaryTokens: string[], hintTokens: string[]): number {
  const searchable = projectSearchText(project);
  const base = scoreText(searchable, primaryTokens) * 2 + scoreText(searchable, hintTokens);
  const hookText = (project.answerHooks || []).join(" ");
  const hookBoost = scoreText(hookText, primaryTokens) * 4 + scoreText(hookText, hintTokens) * 2;
  const exampleText = (project.examples || []).map(exampleSearchText).join(" ");
  const exampleBoost = scoreText(exampleText, primaryTokens) * 2 + scoreText(exampleText, hintTokens);
  return base + hookBoost + exampleBoost;
}

function scoreExperience(experience: CandidateExperience, primaryTokens: string[], hintTokens: string[]): number {
  const searchable = experienceSearchText(experience);
  return scoreText(searchable, primaryTokens) * 2 + scoreText(searchable, hintTokens);
}

function selectExamples(project: CandidateProject, queryTokens: string[], forceOne: boolean) {
  const ranked = (project.examples || [])
    .map((example) => ({ example, score: scoreText(exampleSearchText(example), queryTokens) }))
    .sort((a, b) => b.score - a.score);
  const selected = ranked.filter((entry) => entry.score > 0).slice(0, 1);
  if (selected.length === 0 && forceOne && ranked.length > 0) return ranked.slice(0, 1);
  return selected;
}

function compactExample(example: CandidateProjectExample) {
  return {
    title: clipText(example.title, 160),
    situation: clipText(example.situation, 240),
    approach: clipText(example.approach, 420),
    result: clipText(example.result, 220),
  };
}

function compactProject(
  project: CandidateProject,
  queryTokens: string[],
  question: string,
  broadPersonal: boolean,
  protectedEvidence: boolean,
) {
  const decisions = project.decisions
    .map((item) => ({ item, score: scoreText([item.decision, item.reason, ...(item.tradeoffs || [])].filter(Boolean).join(" "), queryTokens) }))
    .filter((entry) => entry.score > 0 || (protectedEvidence && DECISION_PATTERN.test(question)))
    .sort((a, b) => b.score - a.score)
    .slice(0, protectedEvidence ? 2 : 1)
    .map(({ item }) => ({
      decision: clipText(item.decision, 220),
      reason: clipText(item.reason, 280),
      tradeoffs: rankStrings(item.tradeoffs || [], queryTokens, 2, DECISION_PATTERN.test(question) ? 1 : 0)
        .map((value) => clipText(value, 180)),
    }));

  const challenges = project.challenges
    .map((item) => ({ item, score: scoreText([item.challenge, item.solution, item.result].filter(Boolean).join(" "), queryTokens) }))
    .filter((entry) => entry.score > 0 || (protectedEvidence && CHALLENGE_PATTERN.test(question)))
    .sort((a, b) => b.score - a.score)
    .slice(0, protectedEvidence ? 2 : 1)
    .map(({ item }) => ({
      challenge: clipText(item.challenge, 220),
      solution: clipText(item.solution, 320),
      result: clipText(item.result, 220),
    }));

  const metrics = rankStrings(project.metrics, queryTokens, 3, METRIC_PATTERN.test(question) ? 2 : 0)
    .map((value) => clipText(value, 180));
  const lessons = rankStrings(project.lessons, queryTokens, 2, LESSON_PATTERN.test(question) ? 2 : 0)
    .map((value) => clipText(value, 180));
  const selectedExamples = selectExamples(
    project,
    queryTokens,
    protectedEvidence && (SCENARIO_PATTERN.test(question) || EXAMPLE_PATTERN.test(question) || DECISION_PATTERN.test(question)),
  );

  return {
    name: project.name,
    role: clipText(project.role, 160),
    problem: protectedEvidence || scoreText(project.problem, queryTokens) > 0 || broadPersonal
      ? clipText(project.problem, 320)
      : undefined,
    architecture:
      protectedEvidence || scoreText(project.architecture, queryTokens) > 0 || DECISION_PATTERN.test(question) || broadPersonal
        ? clipText(project.architecture, 480)
        : undefined,
    technologies: rankStrings(project.technologies, queryTokens, 8, protectedEvidence ? 5 : broadPersonal ? 5 : 2),
    examples: selectedExamples.map(({ example }) => compactExample(example)),
    decisions,
    challenges,
    metrics,
    lessons,
  };
}

function compactExperience(experience: CandidateExperience, queryTokens: string[], broadPersonal: boolean) {
  return {
    company: experience.company,
    role: experience.role,
    period: broadPersonal ? experience.period : undefined,
    responsibilities: rankStrings(experience.responsibilities, queryTokens, 4, broadPersonal ? 2 : 0)
      .map((value) => clipText(value, 220)),
    achievements: rankStrings(experience.achievements, queryTokens, 3, broadPersonal ? 2 : 0)
      .map((value) => clipText(value, 220)),
    technologies: rankStrings(experience.technologies, queryTokens, 8, broadPersonal ? 5 : 2),
  };
}

function serializePackCore(pack: CandidateKnowledgePack): string {
  return JSON.stringify({
    profile: pack.profile,
    targetRole: pack.targetRole,
    experience: pack.experience,
    projects: pack.projects,
    skills: pack.skills,
    achievements: pack.achievements,
    facts: pack.facts,
  });
}

function minimalProjectEvidence(project: any) {
  if (!project) return undefined;
  const example = Array.isArray(project.examples) ? project.examples[0] : undefined;
  return {
    name: project.name,
    role: project.role,
    architecture: clipText(project.architecture, 280),
    technologies: Array.isArray(project.technologies) ? project.technologies.slice(0, 5) : [],
    example: example
      ? {
          title: example.title,
          approach: clipText(example.approach, 300),
          result: clipText(example.result, 160),
        }
      : undefined,
    decision: Array.isArray(project.decisions) && project.decisions[0]
      ? {
          decision: clipText(project.decisions[0].decision, 180),
          reason: clipText(project.decisions[0].reason, 220),
        }
      : undefined,
  };
}

function fitContext(context: Record<string, unknown>, maxChars: number): string {
  const pretty = JSON.stringify(context, null, 2);
  if (pretty.length <= maxChars) return pretty;

  const compact = JSON.stringify(context);
  if (compact.length <= maxChars) return compact;

  const degraded = { ...context } as any;
  // Protected project evidence is intentionally preserved before secondary context.
  if (Array.isArray(degraded.supportingProjects)) degraded.supportingProjects = [];
  if (Array.isArray(degraded.relevantExperience)) degraded.relevantExperience = degraded.relevantExperience.slice(0, 1);
  if (Array.isArray(degraded.skills)) degraded.skills = degraded.skills.slice(0, 6);
  if (Array.isArray(degraded.achievements)) degraded.achievements = degraded.achievements.slice(0, 2);
  if (Array.isArray(degraded.facts)) degraded.facts = degraded.facts.slice(0, 3);
  if (degraded.profile?.summary) degraded.profile.summary = clipText(degraded.profile.summary, 260);

  const secondPass = JSON.stringify(degraded);
  if (secondPass.length <= maxChars) return secondPass;

  const minimal = {
    profile: {
      headline: degraded.profile?.headline,
      summary: clipText(degraded.profile?.summary, 180),
      strengths: Array.isArray(degraded.profile?.strengths) ? degraded.profile.strengths.slice(0, 3) : [],
    },
    skills: Array.isArray(degraded.skills) ? degraded.skills.slice(0, 5) : [],
    facts: Array.isArray(degraded.facts) ? degraded.facts.slice(0, 2) : [],
    protectedProjectEvidence: minimalProjectEvidence(degraded.protectedProjectEvidence),
    relevantExperience: Array.isArray(degraded.relevantExperience) ? degraded.relevantExperience.slice(0, 1) : [],
  };

  const finalValue = JSON.stringify(minimal);
  if (finalValue.length <= maxChars) return finalValue;

  const finalProject = minimalProjectEvidence(degraded.protectedProjectEvidence);
  const projectOnly = JSON.stringify({ protectedProjectEvidence: finalProject });
  if (finalProject && projectOnly.length <= maxChars) return projectOnly;

  if (finalProject) {
    const ultraProject = {
      name: finalProject.name,
      architecture: clipText(finalProject.architecture, Math.max(140, Math.min(260, maxChars - 520))),
      technologies: Array.isArray(finalProject.technologies) ? finalProject.technologies.slice(0, 3) : [],
      example: finalProject.example
        ? {
            title: finalProject.example.title,
            approach: clipText(finalProject.example.approach, Math.max(160, maxChars - 430)),
          }
        : undefined,
    };
    const ultraValue = JSON.stringify({ protectedProjectEvidence: ultraProject });
    if (ultraValue.length <= maxChars) return ultraValue;
  }

  return JSON.stringify({
    profile: {
      headline: clipText(degraded.profile?.headline, 120),
      summary: clipText(degraded.profile?.summary, Math.max(100, maxChars - 260)),
    },
  });
}

/**
 * Selects "minimum sufficient evidence": a tiny candidate core plus protected evidence from the
 * best matching real project. `answerHooks` improve matching but are never sent to the model.
 */
export function selectCandidateContextWithMeta(
  pack: CandidateKnowledgePack,
  question: string,
  contextHint = "",
  maxChars = 4_200,
): CandidateContextSelection {
  const budgetChars = Math.max(900, Math.min(maxChars, 12_000));
  const primaryTokens = tokenize(question);
  const hintTokens = tokenize(contextHint);
  const combinedTokens = Array.from(new Set([...primaryTokens, ...hintTokens]));
  const broadPersonalQuestion = BROAD_PERSONAL_PATTERN.test(question);

  const rankedProjects = pack.projects
    .map((project) => ({ project, score: scoreProject(project, primaryTokens, hintTokens) }))
    .sort((a, b) => b.score - a.score);
  const rankedExperience = pack.experience
    .map((experience) => ({ experience, score: scoreExperience(experience, primaryTokens, hintTokens) }))
    .sort((a, b) => b.score - a.score);

  const relevantProjects = rankedProjects.filter((entry) => entry.score > 0).slice(0, budgetChars <= 2_200 ? 1 : 2);
  const relevantExperience = rankedExperience.filter((entry) => entry.score > 0).slice(0, broadPersonalQuestion ? 2 : 1);

  const projectEntries = relevantProjects.length > 0
    ? relevantProjects
    : broadPersonalQuestion
      ? rankedProjects.slice(0, budgetChars <= 2_200 ? 1 : 2)
      : [];
  const experienceEntries = relevantExperience.length > 0
    ? relevantExperience
    : broadPersonalQuestion
      ? rankedExperience.slice(0, 2)
      : [];

  const topProject = projectEntries[0];
  const strongTopProject = (topProject?.score ?? 0) >= 20;
  const projectEvidenceRequired = Boolean(
    topProject &&
    (topProject.score > 0 || broadPersonalQuestion) &&
    (SCENARIO_PATTERN.test(question) || EXAMPLE_PATTERN.test(question) || DECISION_PATTERN.test(question) || broadPersonalQuestion),
  );
  const protectedProjectEvidence = topProject
    ? compactProject(topProject.project, combinedTokens, question, broadPersonalQuestion, projectEvidenceRequired)
    : undefined;
  const supportingProjectEntries = strongTopProject && !broadPersonalQuestion ? [] : projectEntries.slice(1);
  const supportingProjects = supportingProjectEntries.map(({ project }) =>
    compactProject(project, combinedTokens, question, broadPersonalQuestion, false),
  );
  const effectiveExperienceEntries = strongTopProject && projectEvidenceRequired && !broadPersonalQuestion
    ? []
    : experienceEntries;

  const overviewQuestion = OVERVIEW_PATTERN.test(question);
  const useProjectCapsule = Boolean(strongTopProject && projectEvidenceRequired && !overviewQuestion);
  const evidenceStrategy: CandidateContextSelection["evidenceStrategy"] = useProjectCapsule
    ? "project_capsule"
    : broadPersonalQuestion
      ? "broad_profile"
      : "technical_core";

  const profileSummaryBudget = broadPersonalQuestion ? 420 : 200;
  const context = useProjectCapsule
    ? {
        candidateIdentity: {
          headline: clipText(pack.profile.headline, 160),
          projectRole: clipText(topProject?.project.role, 140),
        },
        protectedProjectEvidence,
      }
    : {
        profile: {
          headline: clipText(pack.profile.headline, 160),
          summary: clipText(pack.profile.summary, profileSummaryBudget),
          strengths: rankStrings(pack.profile.strengths, combinedTokens, 6, broadPersonalQuestion ? 5 : 2),
        },
        targetRole: pack.targetRole
          ? {
              title: pack.targetRole.title,
              company: pack.targetRole.company,
              priorities: rankStrings(pack.targetRole.priorities || [], combinedTokens, 4, broadPersonalQuestion ? 2 : 0),
              requirements: rankStrings(pack.targetRole.requirements || [], combinedTokens, 4, 0),
            }
          : undefined,
        skills: rankStrings(pack.skills, combinedTokens, 9, broadPersonalQuestion ? 8 : 5),
        achievements: rankStrings(pack.achievements, combinedTokens, 4, broadPersonalQuestion ? 2 : 0).map((value) => clipText(value, 200)),
        facts: rankStrings(pack.facts, combinedTokens, 6, broadPersonalQuestion ? 3 : 0).map((value) => clipText(value, 200)),
        protectedProjectEvidence,
        supportingProjects,
        relevantExperience: effectiveExperienceEntries.map(({ experience }) => compactExperience(experience, combinedTokens, broadPersonalQuestion)),
      };

  const selectedContext = fitContext(context, budgetChars);
  const rawChars = serializePackCore(pack).length;
  const selectedChars = selectedContext.length;
  const candidateExampleTitles = protectedProjectEvidence?.examples?.map((example: any) => example.title).filter(Boolean) || [];
  const selectedExampleTitles = candidateExampleTitles.filter((title: string) => selectedContext.includes(title));

  return {
    context: selectedContext,
    rawChars,
    selectedChars,
    budgetChars,
    compressionRatio: rawChars > 0 ? Number((selectedChars / rawChars).toFixed(3)) : null,
    selectedProjectNames: projectEntries.map(({ project }) => project.name),
    selectedExperienceLabels: effectiveExperienceEntries.map(({ experience }) =>
      [experience.role, experience.company].filter(Boolean).join(" @ ") || "experience",
    ),
    broadPersonalQuestion,
    topProjectName: topProject?.project.name,
    topProjectScore: topProject?.score,
    projectEvidenceRequired,
    projectExampleIncluded: selectedExampleTitles.length > 0,
    selectedExampleTitles,
    evidenceStrategy,
  };
}

export function selectCandidateContext(
  pack: CandidateKnowledgePack,
  question: string,
  contextHint = "",
  maxChars = 4_200,
): string {
  return selectCandidateContextWithMeta(pack, question, contextHint, maxChars).context;
}
