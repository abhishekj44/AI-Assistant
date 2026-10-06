import type { SessionInfo } from "./conversationTypes";

export function interviewContextBlock(info?: SessionInfo): string {
  const taking = info?.callType === "taking_interview";
  const giving = info?.callType === "giving_interview";
  const text = taking ? info?.candidateProfile : giving ? info?.jobDescription : undefined;
  if (!text?.trim()) return "";
  const tag = taking ? "CANDIDATE_PROFILE_DATA" : "JOB_DESCRIPTION_DATA";
  return `<${tag}>\n${JSON.stringify({ text: text.trim().slice(0, 12_000) })}\n</${tag}>`;
}