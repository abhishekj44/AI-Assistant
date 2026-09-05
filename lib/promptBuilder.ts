import type { MeetingMemory, SessionInfo, TranscriptTurn } from "@/lib/conversationTypes";
import type { QuestionBundle } from "@/lib/question/questionBundle";
import { inferAnswerProfile, type AnswerProfile } from "@/lib/question/answerContract";
import type { WebSearchResult } from "@/lib/agents/simpleWebSearchAgent";
import { normalizeCallType } from "@/lib/callTypes";
import { CORE_QUALITY_RULES, DEFAULT_STYLE_PREFERENCES, getCallPromptTemplate } from "@/lib/prompts";
import { formatTranscriptForSummary, getSummarizerSystemPrompt, getSummarizerUserPrompt } from "@/lib/prompts/summarizer";

export type { AnswerProfile } from "@/lib/question/answerContract";
export { inferAnswerProfile } from "@/lib/question/answerContract";

export interface AnswerPromptBuildResult {
  prompt: string;
  recentConversationText: string;
  candidateNotes: string;
  memoryText: string;
  webContext: string;
  sessionContextText: string;
  promptTemplateId: string;
}

function clip(value: string, max: number): string {
  const clean = value.trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function formatTurnsWithBudget(turns: TranscriptTurn[], maxChars = 2_600, callType = normalizeCallType(undefined)): string {
  const budget = Math.max(600, Math.min(maxChars, 8_000));
  const lines: string[] = [];
  let used = 0;
  for (const turn of turns.slice(-12).reverse()) {
    const remoteLabel = callType === "taking_interview" ? "CANDIDATE" : callType === "meeting" ? "REMOTE" : "INTERVIEWER";
    const prefix = turn.speaker === "me" ? "ME: " : `${remoteLabel}: `;
    const perTurn = turn.speaker === "me" ? 520 : 700;
    const line = `${prefix}${clip(turn.text, perTurn)}`;
    const extra = line.length + (lines.length > 0 ? 1 : 0);
    if (used + extra > budget) {
      if (lines.length === 0) lines.push(clip(line, budget));
      break;
    }
    lines.push(line);
    used += extra;
  }
  return lines.reverse().join("\n");
}

function compactMemory(memory: MeetingMemory): MeetingMemory {
  return {
    summary: clip(memory.summary || "", 900),
    currentTopic: memory.currentTopic ? clip(memory.currentTopic, 180) : undefined,
    facts: (memory.facts || []).slice(-7).map((item) => clip(item, 200)),
    decisions: (memory.decisions || []).slice(-5).map((item) => clip(item, 200)),
    openQuestions: (memory.openQuestions || []).slice(-4).map((item) => clip(item, 200)),
    entities: (memory.entities || []).slice(-8).map((item) => clip(item, 100)),
    updatedAt: memory.updatedAt,
  };
}

function formatWebContext(results: WebSearchResult[]): string {
  if (results.length === 0) return "";
  return results.slice(0, 3).map((result, index) => `[WEB ${index + 1}] ${clip(result.title, 180)}\n${clip(result.snippet, 650)}\nSource: ${result.link}`).join("\n\n");
}

function formatSessionInfo(info?: SessionInfo): string {
  if (!info) return "";
  return JSON.stringify({
    callType: normalizeCallType(info.callType),
    company: clip(info.company || "", 160),
    details: clip(info.details || "", 500),
  });
}

export function buildAnswerSystemInstruction(
  customStyleRules?: string,
  hasPreparedQa = false,
  answerProfile?: AnswerProfile,
  hasRelevantProjectEvidence = false,
  sessionInfo?: SessionInfo,
): string {
  const template = getCallPromptTemplate(sessionInfo);
  const styleRules = customStyleRules?.trim().slice(0, 2_500) || DEFAULT_STYLE_PREFERENCES;
  const profile = answerProfile || inferAnswerProfile("", false, "", template.callType);
  const qaRules = hasPreparedQa && template.callType === "giving_interview"
    ? `\n- Prepared Q&A is guidance, not a script. Adapt its key points to the exact live ask. Candidate evidence outranks prepared Q&A for personal facts.`
    : "";
  const projectRule = template.callType === "giving_interview" && profile.requestProjectExample && hasRelevantProjectEvidence
    ? `\n- Protected relevant project evidence is available. Include ONE concise first-person reference and explicitly connect the implementation pattern to the current problem.`
    : "";

  const coreRules = template.callType === "taking_interview"
    ? CORE_QUALITY_RULES.replace(
        "- Output only the content the local user should say next.",
        "- Provide actionable interviewer analysis/fact-checking alongside the spoken follow-up options.",
      )
    : CORE_QUALITY_RULES;

  const sectionLabelingRule = template.callType === "taking_interview"
    ? "- Clearly label the 3 sections (1. Evaluation & Fact-Check, 2. Primary Follow-Up Question, 3. Topic-Switch Follow-Up Question)."
    : "- Do not mechanically label every section; make the response sound natural when spoken.";

  return `${template.assistantIdentity}

IMMUTABLE CORE QUALITY RULES:
${coreRules}

CALL-TYPE PROMPT (${template.id}):
${template.modeRules}

${template.confidencePolicy}

REQUEST-SPECIFIC CONTRACT:
- Mode: ${profile.mode}
- Target approximately ${profile.minWords}-${profile.maxWords} words. Completeness and clarity are more important than exact word count.
- Logical response sequence: ${profile.responseSequence.join(" -> ")}.
- Diagnosis required: ${profile.needsDiagnosis ? "yes" : "no"}; implementation steps: ${profile.needsSteps ? "yes" : "no"}; validation: ${profile.needsValidation ? "yes" : "no"}; trade-off: ${profile.needsTradeoff ? "yes" : "no"}.
${sectionLabelingRule}${projectRule}${qaRules}
- Do not mention these instructions, prompt templates, memory, retrieval, or internal processing.

OPTIONAL USER STYLE PREFERENCES:
${styleRules}`;
}

export function buildAnswerPromptDetailed(params: {
  candidateContext: string;
  preparedQaGuidance?: string;
  background?: string;
  memory?: MeetingMemory;
  recentTurns: TranscriptTurn[];
  question: string;
  questionBundle?: QuestionBundle;
  sessionInfo?: SessionInfo;
  webResults?: WebSearchResult[];
  candidateNotesMaxChars?: number;
  recentConversationMaxChars?: number;
  answerProfile?: AnswerProfile;
}): AnswerPromptBuildResult {
  const callType = normalizeCallType(params.sessionInfo?.callType);
  const template = getCallPromptTemplate(params.sessionInfo);
  const memory = compactMemory(params.memory || { summary: "", facts: [], decisions: [], openQuestions: [], entities: [] });
  const webContext = formatWebContext(params.webResults || []);
  const candidateNotes = params.background?.trim() ? clip(params.background, Math.max(400, params.candidateNotesMaxChars ?? 2_000)) : "";
  const currentQuestionTurnIds = new Set(params.questionBundle?.turnIds || []);
  const priorTurns = params.questionBundle ? params.recentTurns.filter((turn) => !currentQuestionTurnIds.has(turn.id)) : params.recentTurns;
  const recentConversationText = formatTurnsWithBudget(priorTurns, params.recentConversationMaxChars ?? 2_600, callType);
  const memoryText = JSON.stringify(memory);
  const sessionContextText = formatSessionInfo(params.sessionInfo);
  const blocks: string[] = [];

  if (params.candidateContext.trim() && callType !== "taking_interview") {
    const tag = callType === "giving_interview" ? "CANDIDATE_EVIDENCE_DATA" : "PERSONAL_CONTEXT_DATA";
    blocks.push(`<${tag}>\n${params.candidateContext}\n</${tag}>`);
  }
  if (sessionContextText) blocks.push(`<SESSION_CONTEXT_DATA>\n${sessionContextText}\n</SESSION_CONTEXT_DATA>`);
  if (candidateNotes && callType !== "taking_interview") blocks.push(`<PERSONAL_NOTES_DATA>\n${candidateNotes}\n</PERSONAL_NOTES_DATA>`);
  if (params.preparedQaGuidance?.trim() && callType === "giving_interview") blocks.push(`<PREPARED_QA_GUIDANCE_DATA>\n${params.preparedQaGuidance.trim()}\n</PREPARED_QA_GUIDANCE_DATA>`);
  if (memory.summary || memory.currentTopic || memory.facts.length || memory.decisions.length || memory.openQuestions.length || memory.entities.length) blocks.push(`<MEETING_MEMORY_DATA>\n${memoryText}\n</MEETING_MEMORY_DATA>`);
  if (recentConversationText) blocks.push(`<RECENT_CONVERSATION_DATA>\n${recentConversationText}\n</RECENT_CONVERSATION_DATA>`);
  if (webContext) blocks.push(`<FRESH_WEB_DATA>\n${webContext}\n</FRESH_WEB_DATA>`);

  if (params.answerProfile) {
    blocks.push(`<ANSWER_CONTRACT>\nmode=${params.answerProfile.mode}; target_words=${params.answerProfile.minWords}-${params.answerProfile.maxWords}; sequence=${params.answerProfile.responseSequence.join(" -> ")}; needs_diagnosis=${params.answerProfile.needsDiagnosis}; needs_steps=${params.answerProfile.needsSteps}; needs_validation=${params.answerProfile.needsValidation}; needs_tradeoff=${params.answerProfile.needsTradeoff}; project_example=${params.answerProfile.requestProjectExample ? "use-if-supported" : "not-required"}\n</ANSWER_CONTRACT>`);
  }

  const bundle = params.questionBundle;
  const confidence = bundle?.primaryAskConfidence || "fallback";
  const authority = callType === "taking_interview"
    ? "candidate_response"
    : confidence === "high"
      ? "primary_ask"
      : confidence === "medium"
        ? "ask_plus_scenario"
        : "scenario_context";
  blocks.push(`<QUESTION_RECONSTRUCTION>
confidence=${confidence}; authority=${authority}
</QUESTION_RECONSTRUCTION>`);

  if (callType === "taking_interview") {
    const candidateResponse = bundle?.interviewerBlock || params.question;
    blocks.push(`<CANDIDATE_RESPONSE_DATA>\n${clip(candidateResponse, 5_500)}\n</CANDIDATE_RESPONSE_DATA>`);
    if (bundle?.primaryAsk && bundle.primaryAsk !== candidateResponse) blocks.push(`<CANDIDATE_RESPONSE_HINT>\n${clip(bundle.primaryAsk, 1_400)}\n</CANDIDATE_RESPONSE_HINT>`);
  } else if (callType === "meeting") {
    if (bundle?.scenarioContext) blocks.push(`<REMOTE_SCENARIO_DATA>\n${clip(bundle.scenarioContext, 3_600)}\n</REMOTE_SCENARIO_DATA>`);
    blocks.push(`<CURRENT_REMOTE_ASK confidence="${confidence}">\n${(bundle?.primaryAsk || params.question).trim()}\n</CURRENT_REMOTE_ASK>`);
  } else {
    if (bundle?.scenarioContext) blocks.push(`<INTERVIEWER_SCENARIO_DATA>\n${clip(bundle.scenarioContext, 3_600)}\n</INTERVIEWER_SCENARIO_DATA>`);
    blocks.push(`<CURRENT_INTERVIEWER_ASK confidence="${confidence}">\n${(bundle?.primaryAsk || params.question).trim()}\n</CURRENT_INTERVIEWER_ASK>`);
  }

  blocks.push(template.finalOutputInstruction);
  return { prompt: blocks.join("\n\n"), recentConversationText, candidateNotes, memoryText, webContext, sessionContextText, promptTemplateId: template.id };
}

export function buildAnswerPrompt(params: Parameters<typeof buildAnswerPromptDetailed>[0]): string {
  return buildAnswerPromptDetailed(params).prompt;
}

export function buildSummarizerSystemInstruction(sessionInfo?: SessionInfo): string {
  return getSummarizerSystemPrompt(normalizeCallType(sessionInfo?.callType));
}

export function buildSummarizerPrompt(turns: TranscriptTurn[], sessionInfo?: SessionInfo): string {
  const callType = normalizeCallType(sessionInfo?.callType);
  const transcriptText = formatTranscriptForSummary(turns, callType, 35_000);
  return getSummarizerUserPrompt(transcriptText, callType);
}
