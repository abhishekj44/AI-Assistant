import type { QABank, QAEntry, QAMatch } from "./types";

const STOP_WORDS = new Set([
  "the", "and", "that", "this", "with", "from", "have", "your", "what", "when", "where",
  "which", "would", "could", "should", "about", "into", "there", "their", "they", "were", "been",
  "then", "than", "also", "just", "using", "used", "tell", "explain", "describe", "you", "how",
  "did", "does", "why", "can", "for", "are", "was", "our", "out", "get", "got", "me", "my",
]);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/fine[\s-]?tuning/g, "finetune")
    .replace(/fine[\s-]?tuned/g, "finetune")
    .replace(/fine[\s-]?tune/g, "finetune")
    .replace(/retrieval[\s-]?augmented[\s-]?generation/g, "rag")
    .replace(/[^a-z0-9+#./]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stem(token: string): string {
  if (token.length > 6 && token.endsWith("ing")) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith("ed")) return token.slice(0, -2);
  if (token.length > 5 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function tokenize(text: string): string[] {
  const normalized = normalize(text);
  return Array.from(
    new Set(
      normalized
        .split(" ")
        .map(stem)
        .filter((token) => token.length > 2 && !STOP_WORDS.has(token)),
    ),
  );
}

function tokenHits(text: string, tokens: string[]): number {
  const haystack = new Set(tokenize(text));
  let hits = 0;
  for (const token of tokens) if (haystack.has(token)) hits += 1;
  return hits;
}

function scoreEntry(entry: QAEntry, question: string, contextHint: string): QAMatch {
  const normalizedQuestion = normalize(question);
  const questionTokens = tokenize(question);
  const contextTokens = tokenize(contextHint).slice(-40);

  let bestQuestionScore = 0;
  let matchedQuestion: string | undefined;

  for (const variant of entry.questions) {
    const normalizedVariant = normalize(variant);
    let score = 0;

    if (normalizedVariant && normalizedVariant === normalizedQuestion) score += 100;
    else if (
      normalizedVariant.length >= 8 &&
      (normalizedVariant.includes(normalizedQuestion) || normalizedQuestion.includes(normalizedVariant))
    ) score += 35;

    const hits = tokenHits(variant, questionTokens);
    score += hits * 8;
    if (questionTokens.length > 0) score += (hits / questionTokens.length) * 20;

    // Follow-up questions can be lexically sparse ("why that approach?"). In that case,
    // let recent conversation provide stronger evidence without making it the primary signal.
    const contextHits = tokenHits(variant, contextTokens);
    score += contextHits * (questionTokens.length <= 2 ? 7 : 2);

    if (score > bestQuestionScore) {
      bestQuestionScore = score;
      matchedQuestion = variant;
    }
  }

  const guidanceText = [
    entry.category,
    ...entry.tags,
    ...entry.keyPoints,
    entry.answer,
  ]
    .filter(Boolean)
    .join(" ");

  let score = bestQuestionScore;
  score += tokenHits(guidanceText, questionTokens) * 2;
  score += tokenHits(guidanceText, contextTokens) * (questionTokens.length <= 2 ? 1.5 : 0.5);
  score += Math.max(0, Math.min(entry.priority, 10)) * 0.25;

  return { entry, score: Number(score.toFixed(2)), matchedQuestion };
}

/**
 * Selects prepared Q&A guidance locally. It is intentionally deterministic and network-free.
 * Candidate Knowledge remains the factual source of truth; these matches only guide phrasing/content.
 */
export function selectQAMatches(
  bank: QABank,
  question: string,
  contextHint = "",
  limit = 2,
  minScore = 8,
): QAMatch[] {
  if (!question.trim() || bank.entries.length === 0 || limit <= 0) return [];

  return bank.entries
    .filter((entry) => entry.enabled !== false && entry.questions.length > 0 && entry.answer.trim())
    .map((entry) => scoreEntry(entry, question, contextHint))
    .filter((match) => match.score >= minScore)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.entry.priority - a.entry.priority;
    })
    .slice(0, Math.max(1, Math.min(limit, 5)));
}

export function buildQAGuidance(matches: QAMatch[], maxChars = 4_000): string {
  if (matches.length === 0) return "";
  const budget = Math.max(500, maxChars);
  const selected: Array<Record<string, unknown>> = [];

  for (const match of matches) {
    const candidate = {
      id: match.entry.id,
      category: match.entry.category,
      matchedQuestion: match.matchedQuestion,
      preparedAnswer: match.entry.answer.slice(0, 1_800),
      keyPoints: match.entry.keyPoints.slice(0, 8).map((point) => point.slice(0, 300)),
      personal: match.entry.personal,
      score: match.score,
    };

    const withCandidate = [...selected, candidate];
    if (JSON.stringify(withCandidate).length <= budget) {
      selected.push(candidate);
      continue;
    }

    // Preserve valid JSON even under a very small prompt budget.
    if (selected.length === 0) {
      const compact = {
        ...candidate,
        preparedAnswer: match.entry.answer.slice(0, Math.max(120, budget - 420)),
        keyPoints: match.entry.keyPoints.slice(0, 3).map((point) => point.slice(0, 120)),
      };
      selected.push(compact);
    }
    break;
  }

  return JSON.stringify(selected, null, 2);
}
