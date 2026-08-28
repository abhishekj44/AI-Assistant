import type { CallType } from "@/lib/callTypes";

export interface CallPromptTemplate {
  id: string;
  callType: CallType;
  displayName: string;
  localRole: string;
  remoteRole: string;
  generateActionLabel: string;
  contextLabel: string;
  assistantIdentity: string;
  modeRules: string;
  confidencePolicy: string;
  finalOutputInstruction: string;
}
