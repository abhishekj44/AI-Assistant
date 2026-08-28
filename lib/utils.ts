import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { SessionInfo, TranscriptTurn } from "@/lib/conversationTypes";
import { CORE_QUALITY_RULES, DEFAULT_STYLE_PREFERENCES, getCallPromptTemplate } from "@/lib/prompts";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type { TranscriptTurn } from "@/lib/conversationTypes";

export const PROMPT_RULES_VERSION = 10;
export const PROMPT_STYLE_STORAGE_KEY = "meetingCopilot.promptStyle.v10";
export const PROMPT_RULES_VERSION_STORAGE_KEY = "meetingCopilot.promptRulesVersion";
export const LEGACY_PROMPT_RULES_BACKUP_KEY = "meetingCopilot.legacyPromptRules.v9";
export const PREVIOUS_PROMPT_STYLE_STORAGE_KEY = "meetingCopilot.promptStyle.v9";

/** Compatibility exports. Prompt source-of-truth now lives under lib/prompts/. */
export const CORE_ANSWER_RULES = CORE_QUALITY_RULES;
export const DEFAULT_PROMPT_RULES = DEFAULT_STYLE_PREFERENCES;

export function buildPrompt(
  bg: string | undefined,
  _conversation: string,
  summary?: string,
  recentTurns?: Array<Pick<TranscriptTurn, "speaker" | "text">>,
  customRules?: string,
  sessionInfo?: SessionInfo,
) {
  const styleRules = customRules?.trim() || DEFAULT_PROMPT_RULES;
  const template = getCallPromptTemplate(sessionInfo);
  const turns = (recentTurns || []).slice(-12).map((turn) => `${turn.speaker.toUpperCase()}: ${turn.text}`).join("\n");
  return `${template.assistantIdentity}\n\nCore quality rules:\n${CORE_QUALITY_RULES}\n\nMode rules (${template.displayName}):\n${template.modeRules}\n\nConfidence policy:\n${template.confidencePolicy}\n\nOptional style preferences:\n${styleRules}\n\nPersonal/candidate notes:\n${bg || "(none)"}\n\nMemory:\n${summary || "(none)"}\n\nRecent conversation:\n${turns || "(none)"}\n\n${template.contextLabel}:\n<reconstructed remote context>\n\n${template.finalOutputInstruction}`;
}
