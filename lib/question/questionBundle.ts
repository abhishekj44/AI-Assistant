import type { TranscriptTurn } from "@/lib/conversationTypes";

export interface QuestionBundle {
  primaryAsk: string;
  scenarioContext: string;
  interviewerBlock: string;
  retrievalQuery: string;
  turnIds: string[];
  turnCount: number;
  usedActiveInterim: boolean;
  primaryAskConfidence: "high" | "medium" | "fallback";
}

export interface QuestionBundleOptions {
  maxInterviewerTurns?: number;
  maxChars?: number;
  maxSpanMs?: number;
  activeInterviewerText?: string;
}

const STRONG_ASK_PATTERNS = [
  /\b(?:what|why|how|which|where|when|who)\b/i,
  /\b(?:can|could|would|will)\s+you\b/i,
  /\b(?:what\s+you\s+will\s+do|what\s+would\s+you\s+do|what\s+do\s+you\s+do)\b/i,
  /\b(?:tell\s+me|walk\s+me\s+through|explain|describe)\b/i,
];
const TASK_PATTERNS = [
  /\b(?:solve|fix|design|architect|approach|implement|debug|diagnose|improve|handle|build|deploy|recommend)\b/i,
  /\b(?:given|assume|consider|customer|scenario|problem|situation)\b/i,
];
const FRAGMENT_END = /\b(?:and|or|but|the|a|an|to|of|for|with|about|because|so|if|that|this|those|these|like)\s*$/i;

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  const value = clean(text);
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function splitClauses(text: string): string[] {
  const normalized = clean(text);
  if (!normalized) return [];
  const sentences = normalized
    .split(/(?<=[?.!])\s+|\s+(?=(?:so\s+)?(?:what|why|how|which|can\s+you|could\s+you|would\s+you|will\s+you)\b)/i)
    .map(clean)
    .filter(Boolean);
  return sentences.length ? sentences : [normalized];
}

function scoreAsk(clause: string, recency: number): number {
  if (!clause) return -100;
  let score = recency * 4;
  if (clause.includes("?")) score += 18;
  for (const pattern of STRONG_ASK_PATTERNS) if (pattern.test(clause)) score += 16;
  for (const pattern of TASK_PATTERNS) if (pattern.test(clause)) score += 5;
  if (/\b(?:correct|incorrect|wrong|invalid|fail|failing|miss|undercount|overcount|count|issue|problem)\b/i.test(clause)) score += 4;
  if (/\b(?:expected|actual|instead of|what you will do|what would you do)\b/i.test(clause)) score += 6;
  if (clause.length >= 35) score += 3;
  if (clause.length >= 80) score += 2;
  if (clause.length < 12) score -= 12;
  if (FRAGMENT_END.test(clause)) score -= 10;
  return score;
}

function pickPrimaryAsk(blockTurns: Array<{ text: string }>): { text: string; confidence: QuestionBundle["primaryAskConfidence"] } {
  const candidates: Array<{ text: string; score: number }> = [];
  const total = Math.max(1, blockTurns.length);
  blockTurns.forEach((turn, turnIndex) => {
    for (const clause of splitClauses(turn.text)) {
      candidates.push({ text: clause, score: scoreAsk(clause, (turnIndex + 1) / total) });
    }
  });
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (best && best.score >= 24) return { text: clip(best.text, 1_400), confidence: "high" };
  if (best && best.score >= 14) return { text: clip(best.text, 1_400), confidence: "medium" };
  const fallback = [...blockTurns].reverse().map((turn) => clean(turn.text)).find((text) => text.length >= 2) || "";
  return { text: clip(fallback, 1_400), confidence: "fallback" };
}

/** Reconstructs a long interviewer scenario. Silence is not a semantic boundary; ME is. */
export function buildQuestionBundle(
  turns: Array<Pick<TranscriptTurn, "id" | "speaker" | "text" | "timestamp">>,
  options: QuestionBundleOptions = {},
): QuestionBundle | null {
  const maxTurns = Math.max(1, Math.min(options.maxInterviewerTurns ?? 10, 12));
  const maxChars = Math.max(1_000, Math.min(options.maxChars ?? 5_500, 8_000));
  const maxSpanMs = Math.max(30_000, Math.min(options.maxSpanMs ?? 150_000, 300_000));
  const activeText = clean(options.activeInterviewerText || "");
  const selected: Array<{ id: string; text: string; timestamp: string }> = [];
  let newestTime = activeText ? Date.now() : Number.NaN;
  let usedChars = activeText.length;

  if (activeText) {
    selected.unshift({ id: "active_interviewer", text: activeText, timestamp: new Date().toISOString() });
  } else if (turns.at(-1)?.speaker === "me") {
    return null;
  }

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.speaker === "me") {
      if (selected.length > 0) break;
      return null;
    }
    const text = clean(turn.text);
    if (!text) continue;
    const turnTime = Date.parse(turn.timestamp);
    if (!Number.isFinite(newestTime) && Number.isFinite(turnTime)) newestTime = turnTime;
    if (Number.isFinite(newestTime) && Number.isFinite(turnTime) && newestTime - turnTime > maxSpanMs && selected.length > 0) break;
    if (selected.length >= maxTurns) break;
    const projected = usedChars + text.length + 1;
    if (projected > maxChars && selected.length > 0) break;
    selected.unshift({ id: turn.id, text: projected > maxChars ? clip(text, maxChars - usedChars) : text, timestamp: turn.timestamp });
    usedChars = Math.min(maxChars, projected);
  }

  if (selected.length === 0) return null;
  const interviewerBlock = clip(selected.map((turn) => turn.text).join(" "), maxChars);
  if (!interviewerBlock) return null;
  const primary = pickPrimaryAsk(selected);
  let scenarioContext = interviewerBlock;
  if (primary.text) {
    const index = scenarioContext.toLowerCase().indexOf(primary.text.toLowerCase());
    if (index >= 0) scenarioContext = clean(`${scenarioContext.slice(0, index)} ${scenarioContext.slice(index + primary.text.length)}`);
  }
  scenarioContext = clip(scenarioContext, Math.max(800, maxChars - Math.min(primary.text.length, 1_400)));
  const retrievalQuery = clip([primary.text, scenarioContext].filter(Boolean).join("\nScenario: "), 3_600);

  return {
    primaryAsk: primary.text || interviewerBlock,
    scenarioContext,
    interviewerBlock,
    retrievalQuery,
    turnIds: selected.filter((turn) => turn.id !== "active_interviewer").map((turn) => turn.id),
    turnCount: selected.length,
    usedActiveInterim: Boolean(activeText),
    primaryAskConfidence: primary.confidence,
  };
}

export function sanitizeQuestionBundle(value: unknown): QuestionBundle | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const primaryAsk = typeof raw.primaryAsk === "string" ? clip(raw.primaryAsk, 1_400) : "";
  const interviewerBlock = typeof raw.interviewerBlock === "string" ? clip(raw.interviewerBlock, 5_500) : "";
  if (!primaryAsk && !interviewerBlock) return null;
  const scenarioContext = typeof raw.scenarioContext === "string" ? clip(raw.scenarioContext, 4_200) : "";
  const retrievalQuery = typeof raw.retrievalQuery === "string"
    ? clip(raw.retrievalQuery, 3_600)
    : clip([primaryAsk || interviewerBlock, scenarioContext].filter(Boolean).join("\nScenario: "), 3_600);
  const confidence = raw.primaryAskConfidence === "high" || raw.primaryAskConfidence === "medium" || raw.primaryAskConfidence === "fallback"
    ? raw.primaryAskConfidence
    : "fallback";
  const turnIds = Array.isArray(raw.turnIds)
    ? raw.turnIds.filter((id): id is string => typeof id === "string").slice(-12).map((id) => id.slice(0, 160))
    : [];
  return {
    primaryAsk: primaryAsk || clip(interviewerBlock, 1_400),
    scenarioContext,
    interviewerBlock: interviewerBlock || clip([scenarioContext, primaryAsk].filter(Boolean).join(" "), 5_500),
    retrievalQuery,
    turnIds,
    turnCount: Math.max(1, Math.min(Number(raw.turnCount) || turnIds.length || 1, 12)),
    usedActiveInterim: raw.usedActiveInterim === true,
    primaryAskConfidence: confidence,
  };
}
