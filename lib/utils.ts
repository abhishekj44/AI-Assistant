import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface TranscriptTurn {
  speaker: string;
  text: string;
  timestamp?: string;
}

/**
 * Format structured turns into a speaker-labeled transcript string.
 */
function formatTurns(turns: TranscriptTurn[]): string {
  if (!turns || turns.length === 0) return '';
  return turns
    .map((t) => `${t.speaker.toUpperCase()}: ${t.text}`)
    .join('\n');
}

export const DEFAULT_PROMPT_RULES = `- Provide a clear, comprehensive, and well-structured answer (around 150-250 words)
- Use bullet points for key architecture, technical steps, and trade-offs
- Be specific, actionable, and directly answer the scenario asked
- Keep answers precise with practical technical details
- Sound natural and authoritative in an interview setting
- Skip meta-commentary, introductions, thought processes, and drafting notes (do NOT print "Drafting response:" or word count markers)
- Output ONLY the final answer directly`;

export function buildPrompt(
  bg: string | undefined,
  conversation: string,
  summary?: string,
  recentTurns?: TranscriptTurn[],
  customRules?: string,
) {
  const rules = customRules?.trim() || DEFAULT_PROMPT_RULES;
  const turnsContext = recentTurns && recentTurns.length > 0
    ? formatTurns(recentTurns)
    : conversation;

  return `You are an expert AI interview assistant. Answer the question directly and concisely.

Rules:
${rules}

${bg ? `Background: ${bg}\n` : ''}${summary ? `Prior Conversation Summary:\n${summary}\n\n` : ''}Recent Conversation:
${turnsContext}

Answer:`;
}

export function buildKnowledgeCheckPrompt(conversation: string) {
  return `You are an AI assistant that needs to determine if you have sufficient knowledge to answer a question.

Conversation: ${conversation}

Analyze this conversation and determine:
1. Is there a clear question being asked?
2. Do you have sufficient knowledge to provide a comprehensive answer?
3. Or would you need external documents/context to give a complete response?

Respond with ONLY one of these formats:
- "KNOWN: [brief answer preview]" - if you can answer comprehensively
- "NEED_CONTEXT: [what specific information you need]" - if you need external sources

Examples:
- For "What is React?" → "KNOWN: React is a JavaScript library..."
- For "What's my GPA?" → "NEED_CONTEXT: Personal academic information"
- For "Company policy on remote work?" → "NEED_CONTEXT: Specific company policies"`;
}

export function buildRAGPrompt(
  bg: string | undefined,
  conversation: string,
  extractedQuestion: string,
  context: string,
  summary?: string,
  recentTurns?: TranscriptTurn[],
  customRules?: string,
) {
  const rules = customRules?.trim() || DEFAULT_PROMPT_RULES;
  const turnsContext = recentTurns && recentTurns.length > 0
    ? formatTurns(recentTurns)
    : conversation;

  return `You are an expert AI interview assistant. Answer using the context provided plus your knowledge.

Rules:
${rules}

Context:
${context}

${bg ? `Background: ${bg}\n` : ''}${summary ? `Prior Conversation Summary:\n${summary}\n\n` : ''}Recent Conversation:
${turnsContext}

Question: ${extractedQuestion}

Answer:`;
}

export function buildSummerizerPrompt(text: string) {
  return `You are a summerizer. You are summarizing the given text. Summarize the following text. Only write summary.
Content:
${text}
Summary:
`;
}

