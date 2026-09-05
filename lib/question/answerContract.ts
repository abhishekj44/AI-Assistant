import type { CallType } from "@/lib/callTypes";

export type AnswerMode = "brief" | "technical" | "architecture" | "troubleshooting_architecture" | "project" | "behavioral" | "interviewer_followup" | "meeting_response";

export interface AnswerProfile {
  mode: AnswerMode;
  minWords: number;
  maxWords: number;
  maxOutputTokens: number;
  requestProjectExample: boolean;
  needsDiagnosis: boolean;
  needsSteps: boolean;
  needsValidation: boolean;
  needsTradeoff: boolean;
  responseSequence: string[];
  rationale: string;
}

export function inferAnswerProfile(
  question: string,
  hasRelevantProject: boolean,
  scenarioContext = "",
  callType: CallType = "giving_interview",
): AnswerProfile {
  const text = `${question}\n${scenarioContext}`.toLowerCase();

  if (callType === "taking_interview") {
    return {
      mode: "interviewer_followup",
      minWords: 60,
      maxWords: 250,
      maxOutputTokens: 600,
      requestProjectExample: false,
      needsDiagnosis: false,
      needsSteps: false,
      needsValidation: false,
      needsTradeoff: false,
      responseSequence: [
        "candidate answer evaluation & technical fact-check",
        "primary follow-up question (contradiction / deep probe)",
        "topic-switch follow-up question (pivot option)",
      ],
      rationale: "interviewer evaluation and follow-up generation",
    };
  }

  const behavioral = /\b(tell me about a time|tell me about (?:a )?failure|describe (?:a )?failure|conflict with|leadership example|feedback you received|difficult stakeholder|difficult person|team disagreement|behavioral example)\b/i.test(text);
  const project = /\b(your project|your experience|what did you|what have you|worked on|use case|project example|in your role|you built|you designed|you implemented)\b/i.test(text);
  const architecture = /\b(customer|scenario|how would|design|architect|architecture|approach|solve|solution|pipeline|deploy|integration|integrate|worker|agent|vlm|vision|multimodal|trade-?off|system design)\b/i.test(text);
  const failureSignal = /\b(wrong|incorrect|invalid|fail(?:ed|ing|s)?|issue|problem|undercount(?:ed|ing|s)?|overcount(?:ed|ing|s)?|miss(?:ed|ing|es)?|missing|not working|doesn'?t work|does not work|unable|only\s+\d+|instead of|expected|actual|debug(?:ging)?|diagnos(?:e|ed|ing|is)|count mismatch|correct count)\b/i.test(text);
  const technical = /\b(explain|difference|compare|how does|what is|why use|model|rag|llm|embedding|vector|kubernetes|api|database|latency|throughput)\b/i.test(text);

  if (callType === "meeting") {
    if (architecture || failureSignal) {
      return { mode: "meeting_response", minWords: 75, maxWords: 135, maxOutputTokens: 330, requestProjectExample: false, needsDiagnosis: failureSignal, needsSteps: true, needsValidation: true, needsTradeoff: true, responseSequence: ["recommendation", "reasoning", "next steps", "risk/trade-off"], rationale: "meeting decision/problem response" };
    }
    return { mode: "meeting_response", minWords: 45, maxWords: 100, maxOutputTokens: 250, requestProjectExample: false, needsDiagnosis: false, needsSteps: false, needsValidation: false, needsTradeoff: false, responseSequence: ["direct response", "rationale", "next action if useful"], rationale: "meeting response" };
  }

  if (behavioral) return { mode: "behavioral", minWords: 100, maxWords: 155, maxOutputTokens: 360, requestProjectExample: hasRelevantProject, needsDiagnosis: false, needsSteps: false, needsValidation: false, needsTradeoff: false, responseSequence: ["situation", "action", "result", "lesson"], rationale: "behavioral question" };
  if (architecture && failureSignal) return { mode: "troubleshooting_architecture", minWords: 125, maxWords: 185, maxOutputTokens: 440, requestProjectExample: hasRelevantProject, needsDiagnosis: true, needsSteps: true, needsValidation: true, needsTradeoff: true, responseSequence: ["direct recommendation", "failure diagnosis", "implementation steps", "validation", "relevant project example", "trade-off"], rationale: "customer troubleshooting / architecture scenario" };
  if (architecture) return { mode: "architecture", minWords: 110, maxWords: 170, maxOutputTokens: 420, requestProjectExample: hasRelevantProject, needsDiagnosis: false, needsSteps: true, needsValidation: true, needsTradeoff: true, responseSequence: ["direct recommendation", "architecture", "implementation", "validation", "relevant project example", "trade-off"], rationale: "architecture/scenario question" };
  if (project) return { mode: "project", minWords: 100, maxWords: 160, maxOutputTokens: 390, requestProjectExample: hasRelevantProject, needsDiagnosis: false, needsSteps: false, needsValidation: false, needsTradeoff: /\b(why|trade-?off|decision|choose|chose)\b/i.test(text), responseSequence: ["direct answer", "project context", "what I implemented", "result or learning"], rationale: "candidate/project-specific question" };
  if (technical) return { mode: "technical", minWords: 80, maxWords: 130, maxOutputTokens: 320, requestProjectExample: hasRelevantProject, needsDiagnosis: false, needsSteps: false, needsValidation: false, needsTradeoff: /\b(compare|why|trade-?off|instead)\b/i.test(text), responseSequence: ["direct answer", "mechanism or reasoning", "concrete implication"], rationale: "technical explanation" };
  return { mode: "brief", minWords: 55, maxWords: 95, maxOutputTokens: 250, requestProjectExample: false, needsDiagnosis: false, needsSteps: false, needsValidation: false, needsTradeoff: false, responseSequence: ["direct answer", "brief rationale"], rationale: "brief/default answer" };
}
