import type { CallType } from "@/lib/callTypes";

export type SpeakerRole = "interviewer" | "me";

export interface TranscriptTurn {
  id: string;
  sequenceId: number;
  speaker: SpeakerRole;
  text: string;
  timestamp: string;
  audioStart?: number;
  audioEnd?: number;
  confidence?: number;
  isInterim?: boolean;
}

export interface MeetingMemory {
  summary: string;
  currentTopic?: string;
  facts: string[];
  decisions: string[];
  openQuestions: string[];
  entities: string[];
  updatedAt?: string;
}

export const EMPTY_MEETING_MEMORY: MeetingMemory = {
  summary: "",
  facts: [],
  decisions: [],
  openQuestions: [],
  entities: [],
};

export interface SessionInfo {
  company: string;
  callType: CallType;
  details: string;
}
