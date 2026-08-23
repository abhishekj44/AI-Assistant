import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { TranscriptTurn } from "@/lib/conversationTypes";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type { TranscriptTurn } from "@/lib/conversationTypes";

export const DEFAULT_PROMPT_RULES = `- Start directly with the answer; no preamble.
- Keep the answer concise enough to read while speaking; request-specific word guidance may expand architecture or project answers.
- Use natural first-person language for questions about my own experience.
- Use 2-4 concise sentences or up to 3 short bullets when bullets improve clarity.
- For architecture questions, mention the decision, rationale, and one relevant trade-off.
- Be concrete and technically accurate; avoid generic filler.
- Output only the suggested answer.`;

/** Lightweight prompt preview used by the settings modal. */
export function buildPrompt(
  bg: string | undefined,
  _conversation: string,
  summary?: string,
  recentTurns?: Array<Pick<TranscriptTurn, "speaker" | "text">>,
  customRules?: string,
) {
  const rules = customRules?.trim() || DEFAULT_PROMPT_RULES;
  const turns = (recentTurns || [])
    .slice(-12)
    .map((turn) => `${turn.speaker.toUpperCase()}: ${turn.text}`)
    .join("\n");
  return `You are a low-latency live meeting copilot.\n\nCandidate notes:\n${bg || "(none)"}\n\nRules:\n${rules}\n\nMeeting memory:\n${summary || "(none)"}\n\nRecent conversation:\n${turns || "(none)"}\n\nCurrent interviewer question:\n<latest interviewer turn>\n\nSuggested answer:`;
}
