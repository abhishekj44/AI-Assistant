export type CallType = "meeting" | "giving_interview" | "taking_interview";

export const CALL_TYPES: Array<{
  value: CallType;
  label: string;
  description: string;
}> = [
  {
    value: "giving_interview",
    label: "Giving Interview",
    description: "You are the candidate. Generate clear answers to the remote interviewer.",
  },
  {
    value: "taking_interview",
    label: "Taking Interview",
    description: "You are the interviewer. Generate targeted follow-ups from the candidate's response. Microphone capture is recommended for clean turn boundaries.",
  },
  {
    value: "meeting",
    label: "Meeting",
    description: "Neutral meeting copilot for responses, decisions, clarification, and next steps.",
  },
];

/** Backward-compatible normalization for V9 and older persisted sessions. */
export function normalizeCallType(value: unknown): CallType {
  if (value === "giving_interview" || value === "taking_interview" || value === "meeting") return value;
  if (value === "interview" || value === "screen") return "giving_interview";
  return "meeting";
}

export function callTypeLabel(value: unknown): string {
  const normalized = normalizeCallType(value);
  return CALL_TYPES.find((item) => item.value === normalized)?.label || "Meeting";
}
