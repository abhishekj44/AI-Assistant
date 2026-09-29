import type { SessionInfo } from "@/lib/conversationTypes";
import { normalizeCallType, type CallType } from "@/lib/callTypes";
import type { CallPromptTemplate } from "@/lib/prompts/types";
import { GIVING_INTERVIEW_PROMPT } from "@/lib/prompts/givingInterview";
import { TAKING_INTERVIEW_PROMPT, TAKING_COURSE_INTERVIEW_PROMPT } from "@/lib/prompts/takingInterview";
import { MEETING_PROMPT } from "@/lib/prompts/meeting";

const REGISTRY: Record<CallType, CallPromptTemplate> = {
  giving_interview: GIVING_INTERVIEW_PROMPT,
  taking_interview: TAKING_INTERVIEW_PROMPT,
  meeting: MEETING_PROMPT,
};

export function getCallPromptTemplate(info?: Pick<SessionInfo, "callType" | "modeVariant"> | null): CallPromptTemplate {
  if (info?.callType === "taking_interview" && info?.modeVariant === "course_admission") {
    return TAKING_COURSE_INTERVIEW_PROMPT;
  }
  return REGISTRY[normalizeCallType(info?.callType)];
}

export { CORE_QUALITY_RULES, DEFAULT_STYLE_PREFERENCES } from "@/lib/prompts/common";
export type { CallPromptTemplate } from "@/lib/prompts/types";
