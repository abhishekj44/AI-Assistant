import crypto from "node:crypto";
import { FLAGS } from "@/lib/types";
import type { MeetingMemory, SessionInfo, SpeakerRole, TranscriptTurn } from "@/lib/conversationTypes";
import { normalizeCallType } from "@/lib/callTypes";
import { EMPTY_MEETING_MEMORY } from "@/lib/conversationTypes";
import { readKnowledgePackWithMeta } from "@/lib/server/knowledgeStore";
import { EMPTY_KNOWLEDGE_PACK } from "@/lib/knowledge/types";
import { selectCandidateContextWithMeta, type CandidateContextSelection } from "@/lib/knowledge/contextSelector";
import { buildQAGuidance, selectQAMatches } from "@/lib/qa/qaSelector";
import { readQABankWithMeta } from "@/lib/server/qaStore";
import { EMPTY_QA_BANK } from "@/lib/qa/types";
import { webSearchAgent, type WebSearchResult } from "@/lib/agents/simpleWebSearchAgent";
import {
  buildAnswerPromptDetailed,
  buildAnswerSystemInstruction,
  buildSummarizerPrompt,
  buildSummarizerSystemInstruction,
} from "@/lib/promptBuilder";
import { createLLMStream } from "@/lib/llm/providerRouter";
import { LLMProviderError } from "@/lib/llm/types";
import type { CompletionContextSnapshot } from "@/lib/diagnostics/types";
import { buildQuestionBundle, sanitizeQuestionBundle, type QuestionBundle } from "@/lib/question/questionBundle";
import { inferAnswerProfile } from "@/lib/question/answerContract";

export const runtime = "nodejs";

const MAX_RECENT_TURNS = 16;

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(Math.max(min, Math.min(parsed, max))) : fallback;
}

const WEB_TIMEOUT_MS = boundedInt(process.env.WEB_SEARCH_TIMEOUT_MS, 1_200, 300, 5_000);
const MAX_OUTPUT_TOKENS = boundedInt(process.env.LLM_MAX_OUTPUT_TOKENS, 750, 64, 1_000);
const CANDIDATE_CONTEXT_MAX_CHARS = boundedInt(process.env.CANDIDATE_CONTEXT_MAX_CHARS, 4_200, 900, 5_000);
const CANDIDATE_CONTEXT_STRONG_QA_CHARS = boundedInt(
  process.env.CANDIDATE_CONTEXT_STRONG_QA_CHARS,
  1_800,
  900,
  6_000,
);
const QA_STRONG_MATCH_SCORE = boundedInt(process.env.QA_STRONG_MATCH_SCORE, 30, 8, 150);
const QA_CONTEXT_MAX_CHARS = boundedInt(process.env.QA_CONTEXT_MAX_CHARS, 2_400, 500, 2_800);
const CANDIDATE_NOTES_MAX_CHARS = boundedInt(process.env.CANDIDATE_NOTES_MAX_CHARS, 2_000, 400, 6_000);
const RECENT_CONTEXT_MAX_CHARS = boundedInt(process.env.RECENT_CONTEXT_MAX_CHARS, 2_600, 600, 8_000);

interface PreGenerationMetrics {
  requestParseMs?: number;
  sanitizeMs?: number;
  questionDeriveMs?: number;
  knowledgeReadMs?: number;
  knowledgeCacheHit?: boolean;
  webMs?: number;
  selectorMs?: number;
  contextMs?: number;
  promptBuildMs?: number;
  knowledgeSources?: number;
  candidateRawChars?: number;
  candidateContextChars?: number;
  candidateBudgetChars?: number;
  candidateCompressionRatio?: number | null;
  recentContextChars?: number;
  candidateNotesChars?: number;
  qaBankEntries?: number;
  qaReadMs?: number;
  qaCacheHit?: boolean;
  qaSelectionMs?: number;
  qaMatches?: number;
  qaTopScore?: number | null;
  qaContextChars?: number;
  qaStrongMatch?: boolean;
  promptChars?: number;
  systemInstructionChars?: number;
  recentTurnsCount?: number;
  topProjectName?: string;
  topProjectScore?: number;
  projectEvidenceRequired?: boolean;
  projectExampleIncluded?: boolean;
  answerMode?: string;
  answerTargetWords?: string;
  evidenceStrategy?: string;
  questionBundleTurns?: number;
  scenarioContextChars?: number;
  primaryAskConfidence?: string;
  questionAuthority?: string;
  sessionContextChars?: number;
  callType?: string;
  promptTemplateId?: string;
}

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sanitizeTurns(value: unknown): TranscriptTurn[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-MAX_RECENT_TURNS)
    .map((turn: unknown, index): TranscriptTurn | null => {
      const candidate = turn && typeof turn === "object" ? (turn as Record<string, unknown>) : {};
      const text = typeof candidate.text === "string" ? candidate.text.trim().slice(0, 2_000) : "";
      if (!text) return null;

      const speaker: SpeakerRole = candidate.speaker === "me" ? "me" : "interviewer";
      return {
        id: typeof candidate.id === "string" ? candidate.id : `request_turn_${index}`,
        sequenceId: Number.isFinite(candidate.sequenceId) ? Number(candidate.sequenceId) : index,
        speaker,
        text,
        timestamp: typeof candidate.timestamp === "string" ? candidate.timestamp : new Date().toISOString(),
        audioStart: Number.isFinite(candidate.audioStart) ? Number(candidate.audioStart) : undefined,
        audioEnd: Number.isFinite(candidate.audioEnd) ? Number(candidate.audioEnd) : undefined,
        isInterim: false,
      };
    })
    .filter((turn): turn is TranscriptTurn => turn !== null);
}

function sanitizeMemory(value: unknown): MeetingMemory {
  if (!value || typeof value !== "object") return EMPTY_MEETING_MEMORY;
  const memory = value as Record<string, unknown>;
  const stringList = (items: unknown) =>
    Array.isArray(items) ? items.filter((x): x is string => typeof x === "string").slice(0, 30) : [];
  return {
    summary: typeof memory.summary === "string" ? memory.summary.slice(0, 2_500) : "",
    currentTopic: typeof memory.currentTopic === "string" ? memory.currentTopic.slice(0, 250) : undefined,
    facts: stringList(memory.facts),
    decisions: stringList(memory.decisions),
    openQuestions: stringList(memory.openQuestions),
    entities: stringList(memory.entities),
    updatedAt: typeof memory.updatedAt === "string" ? memory.updatedAt : undefined,
  };
}

function sanitizeSessionInfo(value: unknown): SessionInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const callType = normalizeCallType(raw.callType);
  const company = typeof raw.company === "string" ? raw.company.trim().slice(0, 160) : "";
  const details = typeof raw.details === "string" ? raw.details.trim().slice(0, 500) : "";
  return { company, callType, details };
}

function fallbackQuestionBundle(question: string, turns: TranscriptTurn[]): QuestionBundle | null {
  if (!question.trim()) return null;
  const latest = [...turns].reverse().find((turn) => turn.speaker === "interviewer");
  return {
    primaryAsk: question.trim().slice(0, 1_400),
    scenarioContext: "",
    interviewerBlock: question.trim().slice(0, 5_500),
    retrievalQuery: question.trim().slice(0, 3_600),
    turnIds: latest ? [latest.id] : [],
    turnCount: latest ? 1 : 0,
    usedActiveInterim: false,
    primaryAskConfidence: "fallback",
  };
}

function deriveQuestion(focusQuestion: unknown, turns: TranscriptTurn[]): string {
  if (typeof focusQuestion === "string" && focusQuestion.trim().length >= 2) {
    return focusQuestion.trim().slice(0, 4_000);
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].speaker === "interviewer" && turns[i].text.trim()) return turns[i].text.trim();
  }
  return "";
}

function questionAuthority(callType: string, confidence: QuestionBundle["primaryAskConfidence"]): string {
  if (callType === "taking_interview") return "candidate_response";
  if (confidence === "high") return "primary_ask";
  if (confidence === "medium") return "ask_plus_scenario";
  return "scenario_context";
}

function needsFreshWeb(question: string): boolean {
  return /\b(today|currently\s+(?:available|supported|ceo|president|version|price|pricing|released)|current\s+(?:version|price|pricing|ceo|president|release|status)|latest|recent\s+(?:news|release|update)|this\s+(?:week|month|year)|as\s+of\s+20\d{2}|released\s+(?:today|recently|this))\b/i.test(question);
}

async function searchFreshWeb(question: string): Promise<{ results: WebSearchResult[]; elapsedMs: number }> {
  if (!needsFreshWeb(question) || !process.env.TAVILY_API_KEY) return { results: [], elapsedMs: 0 };
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEB_TIMEOUT_MS);
  try {
    const response = await webSearchAgent.searchWeb(question, 3, controller.signal);
    return { results: response.results, elapsedMs: Math.round(performance.now() - started) };
  } catch (error: any) {
    if (error?.name !== "AbortError") console.warn("Fresh web lookup failed; continuing without web context", error?.message);
    return { results: [], elapsedMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timeout);
  }
}

function webCitations(results: WebSearchResult[]) {
  return results.map((result) => ({
    sourceType: "web",
    title: result.title,
    source: result.source,
    url: result.link,
    contextSnippet: result.snippet.slice(0, 220),
  }));
}

export async function POST(request: Request) {
  const requestStarted = performance.now();
  const requestId = crypto.randomUUID();

  try {
    const parseStarted = performance.now();
    const body = await request.json();
    const requestParseMs = Math.round(performance.now() - parseStarted);

    const sanitizeStarted = performance.now();
    const flag = body?.flag;
    const recentTurns = sanitizeTurns(body?.recentTurns);
    const memory = sanitizeMemory(body?.memory);
    const sessionInfo = sanitizeSessionInfo(body?.sessionInfo);
    const callType = normalizeCallType(sessionInfo?.callType);
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId.slice(0, 200) : undefined;
    const sanitizeMs = Math.round(performance.now() - sanitizeStarted);

    if (flag === FLAGS.SUMMERIZER) {
      if (recentTurns.length === 0) {
        return Response.json({ error: "No transcript is available to summarize" }, { status: 400 });
      }
      const promptStarted = performance.now();
      const prompt = buildSummarizerPrompt(recentTurns, sessionInfo);
      const summarizerSystemInstruction = buildSummarizerSystemInstruction(sessionInfo);
      const promptBuildMs = Math.round(performance.now() - promptStarted);
      return streamToClient({
        requestId,
        requestStarted,
        prompt,
        systemInstruction: summarizerSystemInstruction,
        sessionId,
        webResults: [],
        preGenerationMetrics: {
          requestParseMs,
          sanitizeMs,
          promptBuildMs,
          promptChars: prompt.length,
          systemInstructionChars: summarizerSystemInstruction.length,
          recentTurnsCount: recentTurns.length,
        },
      });
    }

    if (flag !== FLAGS.COPILOT) return Response.json({ error: "Invalid request flag" }, { status: 400 });

    const questionStarted = performance.now();
    const legacyQuestion = deriveQuestion(body?.focusQuestion, recentTurns);
    const clientBundle = sanitizeQuestionBundle(body?.questionBundle);
    const serverBundle = buildQuestionBundle(recentTurns, { maxInterviewerTurns: 10, maxChars: 5_500, maxSpanMs: 150_000 });
    let questionBundle = clientBundle || serverBundle || fallbackQuestionBundle(legacyQuestion, recentTurns);
    if (clientBundle?.primaryAskConfidence === "fallback" && serverBundle && serverBundle.primaryAskConfidence !== "fallback") {
      questionBundle = { ...clientBundle, primaryAsk: serverBundle.primaryAsk, primaryAskConfidence: serverBundle.primaryAskConfidence };
    }
    const question = callType === "taking_interview"
      ? (questionBundle?.interviewerBlock || legacyQuestion).slice(-1_400)
      : (questionBundle?.primaryAsk || legacyQuestion);
    const questionDeriveMs = Math.round(performance.now() - questionStarted);
    if (!question || !questionBundle) {
      return Response.json({ error: callType === "taking_interview" ? "No finalized candidate response is available yet" : "No finalized remote ask is available yet" }, { status: 400 });
    }
    const scenarioContext = questionBundle.scenarioContext;
    const retrievalQuestion = questionBundle.retrievalQuery || question;

    const contextStarted = performance.now();
    const useCandidateEvidence = callType !== "taking_interview";
    const usePreparedQa = callType === "giving_interview";
    const knowledgePromise = useCandidateEvidence
      ? (async () => {
          const started = performance.now();
          const result = await readKnowledgePackWithMeta();
          return { ...result, elapsedMs: Math.round(performance.now() - started) };
        })()
      : Promise.resolve({ pack: EMPTY_KNOWLEDGE_PACK, cacheHit: true, elapsedMs: 0 });
    const qaPromise = usePreparedQa
      ? (async () => {
          const started = performance.now();
          const result = await readQABankWithMeta();
          return { ...result, elapsedMs: Math.round(performance.now() - started) };
        })()
      : Promise.resolve({ bank: EMPTY_QA_BANK, cacheHit: true, elapsedMs: 0 });
    const freshQuery = [question, scenarioContext.slice(-900)].filter(Boolean).join(" ");
    const webPromise = callType === "taking_interview" ? Promise.resolve({ results: [], elapsedMs: 0 }) : searchFreshWeb(freshQuery);
    const [knowledge, qa, web] = await Promise.all([knowledgePromise, qaPromise, webPromise]);
    const pack = knowledge.pack;

    const currentQuestionTurnIds = new Set(questionBundle.turnIds);
    const priorTurns = recentTurns.filter((turn) => !currentQuestionTurnIds.has(turn.id));
    const selectorHint = [
      memory.currentTopic,
      ...memory.entities.slice(-8),
      memory.summary.slice(-900),
      ...priorTurns.slice(-6).map((turn) => turn.text),
    ].filter(Boolean).join("\n");

    const qaSelectorStarted = performance.now();
    const configuredQaLimit = boundedInt(process.env.QA_MATCH_LIMIT, 2, 0, 5);
    const configuredQaMinScore = boundedInt(process.env.QA_MATCH_MIN_SCORE, 8, 0, 100);
    const qaMatches = selectQAMatches(qa.bank, question, [scenarioContext, selectorHint].filter(Boolean).join("\n"), configuredQaLimit, configuredQaMinScore);
    const qaSelectionMs = Math.round(performance.now() - qaSelectorStarted);
    const qaStrongMatch = (qaMatches[0]?.score ?? 0) >= QA_STRONG_MATCH_SCORE;
    const candidateBudgetChars = qaStrongMatch ? Math.min(CANDIDATE_CONTEXT_MAX_CHARS, CANDIDATE_CONTEXT_STRONG_QA_CHARS) : CANDIDATE_CONTEXT_MAX_CHARS;

    const selectorStarted = performance.now();
    const candidateSelection: CandidateContextSelection = useCandidateEvidence
      ? selectCandidateContextWithMeta(pack, retrievalQuestion, selectorHint, candidateBudgetChars)
      : {
          context: "",
          rawChars: 0,
          selectedChars: 0,
          budgetChars: 0,
          compressionRatio: null,
          selectedProjectNames: [],
          selectedExperienceLabels: [],
          broadPersonalQuestion: false,
          projectEvidenceRequired: false,
          projectExampleIncluded: false,
          selectedExampleTitles: [],
          evidenceStrategy: "technical_core",
        };
    const selectorMs = Math.round(performance.now() - selectorStarted);
    const qaGuidance = buildQAGuidance(qaMatches, QA_CONTEXT_MAX_CHARS);
    const answerProfile = inferAnswerProfile(question, candidateSelection.projectEvidenceRequired, scenarioContext, callType);
    const contextMs = Math.round(performance.now() - contextStarted);

    const promptStarted = performance.now();
    const promptParts = buildAnswerPromptDetailed({
      candidateContext: candidateSelection.context,
      preparedQaGuidance: qaGuidance,
      background: typeof body?.bg === "string" ? body.bg : undefined,
      memory,
      recentTurns,
      question,
      questionBundle,
      sessionInfo,
      webResults: web.results,
      candidateNotesMaxChars: CANDIDATE_NOTES_MAX_CHARS,
      recentConversationMaxChars: RECENT_CONTEXT_MAX_CHARS,
      answerProfile,
    });
    const systemInstruction = buildAnswerSystemInstruction(
      typeof body?.customRules === "string" ? body.customRules : undefined,
      qaMatches.length > 0,
      answerProfile,
      candidateSelection.projectEvidenceRequired,
      sessionInfo,
    );
    const promptBuildMs = Math.round(performance.now() - promptStarted);

    const contextSnapshot: CompletionContextSnapshot = {
      requestId,
      createdAt: new Date().toISOString(),
      question,
      questionBundle: {
        primaryAsk: questionBundle.primaryAsk,
        scenarioContext: questionBundle.scenarioContext,
        interviewerBlock: questionBundle.interviewerBlock,
        retrievalQuery: questionBundle.retrievalQuery,
        turnCount: questionBundle.turnCount,
        usedActiveInterim: questionBundle.usedActiveInterim,
        primaryAskConfidence: questionBundle.primaryAskConfidence,
        authority: questionAuthority(callType, questionBundle.primaryAskConfidence),
      },
      candidate: {
        selectedContext: candidateSelection.context,
        rawChars: candidateSelection.rawChars,
        selectedChars: candidateSelection.selectedChars,
        budgetChars: candidateSelection.budgetChars,
        compressionRatio: candidateSelection.compressionRatio,
        selectedProjects: candidateSelection.selectedProjectNames,
        selectedExperience: candidateSelection.selectedExperienceLabels,
        broadPersonalQuestion: candidateSelection.broadPersonalQuestion,
        topProjectName: candidateSelection.topProjectName,
        topProjectScore: candidateSelection.topProjectScore,
        projectEvidenceRequired: candidateSelection.projectEvidenceRequired,
        projectExampleIncluded: candidateSelection.projectExampleIncluded,
        selectedExampleTitles: candidateSelection.selectedExampleTitles,
        evidenceStrategy: candidateSelection.evidenceStrategy,
      },
      answerProfile,
      qna: {
        bankEntries: qa.bank.entries.length,
        strongMatch: qaStrongMatch,
        matches: qaMatches.map((match) => ({
          id: match.entry.id,
          category: match.entry.category,
          score: match.score,
          matchedQuestion: match.matchedQuestion,
          primaryQuestion: match.entry.questions[0] || "",
          preparedAnswer: match.entry.answer.slice(0, 1_800),
          keyPoints: match.entry.keyPoints.slice(0, 8),
          tags: match.entry.tags.slice(0, 12),
          personal: match.entry.personal,
        })),
        guidance: qaGuidance,
      },
      meetingMemoryText: promptParts.memoryText,
      recentConversationText: promptParts.recentConversationText,
      candidateNotes: promptParts.candidateNotes,
      sessionContextText: promptParts.sessionContextText,
      promptTemplateId: promptParts.promptTemplateId,
      callType,
      webContextText: promptParts.webContext,
      systemInstruction,
      prompt: promptParts.prompt,
      promptChars: promptParts.prompt.length,
      systemInstructionChars: systemInstruction.length,
    };

    return streamToClient({
      requestId,
      requestStarted,
      prompt: promptParts.prompt,
      systemInstruction,
      sessionId,
      webResults: web.results,
      contextSnapshot,
      preGenerationMetrics: {
        requestParseMs,
        sanitizeMs,
        questionDeriveMs,
        knowledgeReadMs: knowledge.elapsedMs,
        knowledgeCacheHit: knowledge.cacheHit,
        webMs: web.elapsedMs,
        selectorMs,
        contextMs,
        promptBuildMs,
        knowledgeSources: pack.sources.length,
        candidateRawChars: candidateSelection.rawChars,
        candidateContextChars: candidateSelection.selectedChars,
        candidateBudgetChars: candidateSelection.budgetChars,
        candidateCompressionRatio: candidateSelection.compressionRatio,
        recentContextChars: promptParts.recentConversationText.length,
        candidateNotesChars: promptParts.candidateNotes.length,
        qaBankEntries: qa.bank.entries.length,
        qaReadMs: qa.elapsedMs,
        qaCacheHit: qa.cacheHit,
        qaSelectionMs,
        qaMatches: qaMatches.length,
        qaTopScore: qaMatches[0]?.score ?? null,
        qaContextChars: qaGuidance.length,
        qaStrongMatch,
        promptChars: promptParts.prompt.length,
        systemInstructionChars: systemInstruction.length,
        recentTurnsCount: recentTurns.length,
        topProjectName: candidateSelection.topProjectName,
        topProjectScore: candidateSelection.topProjectScore,
        projectEvidenceRequired: candidateSelection.projectEvidenceRequired,
        projectExampleIncluded: candidateSelection.projectExampleIncluded,
        answerMode: answerProfile.mode,
        answerTargetWords: `${answerProfile.minWords}-${answerProfile.maxWords}`,
        evidenceStrategy: candidateSelection.evidenceStrategy,
        questionBundleTurns: questionBundle.turnCount,
        scenarioContextChars: questionBundle.scenarioContext.length,
        primaryAskConfidence: questionBundle.primaryAskConfidence,
        questionAuthority: questionAuthority(callType, questionBundle.primaryAskConfidence),
        sessionContextChars: promptParts.sessionContextText.length,
        callType,
        promptTemplateId: promptParts.promptTemplateId,
      },
      question,
      maxOutputTokens: Math.min(MAX_OUTPUT_TOKENS, answerProfile.maxOutputTokens),
    });
  } catch (error: any) {
    console.error(`[completion:${requestId}] request failed`, error);
    const status = error instanceof LLMProviderError && error.status && error.status < 500 ? error.status : 503;
    return Response.json(
      { error: "Unable to generate an answer", details: error?.message, requestId },
      { status },
    );
  }
}

function streamToClient(params: {
  requestId: string;
  requestStarted: number;
  prompt: string;
  systemInstruction?: string;
  sessionId?: string;
  question?: string;
  webResults: WebSearchResult[];
  contextSnapshot?: CompletionContextSnapshot;
  preGenerationMetrics?: PreGenerationMetrics;
  maxOutputTokens?: number;
}) {
  const preModelMs = Math.round(performance.now() - params.requestStarted);

  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Return HTTP/SSE immediately. This keeps the UI responsive even while the provider is queued.
      if (params.contextSnapshot) controller.enqueue(sse("context", params.contextSnapshot));
      controller.enqueue(sse("status", { stage: "model_wait", message: "Preparing model response…" }));

      const run = async () => {
        let handle: Awaited<ReturnType<typeof createLLMStream>> | null = null;
        let modelConnectMs = 0;
        let firstChunkAt: number | null = null;
        let firstTokenAt: number | null = null;
        let outputChars = 0;
        let inputTokens: number | undefined;
        let outputTokens: number | undefined;
        let totalTokens: number | undefined;
        let cachedInputTokens: number | undefined;
        let thoughtTokens: number | undefined;
        let serviceTierActual: string | undefined;
        let emittedText = false;

        try {
          const connectStarted = performance.now();
          handle = await createLLMStream(params.prompt, {
            maxOutputTokens: params.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
            sessionId: params.sessionId,
            systemInstruction: params.systemInstruction,
          });
          modelConnectMs = Math.round(performance.now() - connectStarted);
          if (cancelled) return;

          controller.enqueue(
            sse("meta", {
              requestId: params.requestId,
              provider: handle.provider,
              model: handle.model,
              question: params.question,
              ...params.preGenerationMetrics,
              preModelMs,
              modelConnectMs,
              attemptCount: handle.diagnostics?.attemptCount ?? 1,
              attemptedTargets: handle.diagnostics?.attemptedTargets ?? [`${handle.provider}:${handle.model}`],
              thinkingLevel: handle.diagnostics?.thinkingLevel,
              serviceTierRequested: handle.diagnostics?.serviceTierRequested,
            }),
          );

          const streamIterationStarted = performance.now();
          for await (const chunk of handle.stream) {
            if (cancelled) break;
            if (!firstChunkAt) firstChunkAt = performance.now();
            if (chunk.usage?.inputTokens != null) inputTokens = chunk.usage.inputTokens;
            if (chunk.usage?.outputTokens != null) outputTokens = chunk.usage.outputTokens;
            if (chunk.usage?.totalTokens != null) totalTokens = chunk.usage.totalTokens;
            if (chunk.usage?.cachedInputTokens != null) cachedInputTokens = chunk.usage.cachedInputTokens;
            if (chunk.usage?.thoughtTokens != null) thoughtTokens = chunk.usage.thoughtTokens;
            if (chunk.usage?.serviceTierActual) serviceTierActual = chunk.usage.serviceTierActual;
            if (!chunk.text) continue;
            if (!firstTokenAt) {
              firstTokenAt = performance.now();
              controller.enqueue(sse("status", { stage: "streaming", message: "Streaming answer…" }));
            }
            emittedText = true;
            outputChars += chunk.text.length;
            controller.enqueue(sse("delta", { text: chunk.text }));
          }

          if (!emittedText) {
            const fallbackText = "I could not generate a useful response for that question.";
            if (!firstChunkAt) firstChunkAt = performance.now();
            if (!firstTokenAt) firstTokenAt = performance.now();
            outputChars += fallbackText.length;
            controller.enqueue(sse("delta", { text: fallbackText }));
          }

          if (params.webResults.length > 0) {
            controller.enqueue(sse("sources", { citations: webCitations(params.webResults) }));
          }

          const completedAt = performance.now();
          const estimatedTokens = outputTokens ?? Math.max(1, Math.round(outputChars / 4));
          const generationMs = firstTokenAt ? Math.max(1, completedAt - firstTokenAt) : 0;
          const firstChunkDelayMs = firstChunkAt ? Math.round(firstChunkAt - streamIterationStarted) : null;
          const firstChunkServerMs = firstChunkAt ? Math.round(firstChunkAt - params.requestStarted) : null;
          const modelWaitMs = modelConnectMs + (firstChunkDelayMs ?? 0);
          const cacheHitPercent =
            inputTokens && cachedInputTokens != null
              ? Number(((cachedInputTokens / Math.max(1, inputTokens)) * 100).toFixed(1))
              : null;

          const metrics = {
            requestId: params.requestId,
            provider: handle.provider,
            model: handle.model,
            serverTtftMs: firstTokenAt ? Math.round(firstTokenAt - params.requestStarted) : null,
            firstChunkServerMs,
            preModelMs,
            modelConnectMs,
            firstChunkDelayMs,
            modelWaitMs,
            generationMs: Math.round(generationMs),
            totalMs: Math.round(completedAt - params.requestStarted),
            inputTokens,
            cachedInputTokens,
            cacheHitPercent,
            thoughtTokens,
            outputTokens: estimatedTokens,
            totalTokens,
            tokensPerSecond: generationMs > 0 ? Number((estimatedTokens / (generationMs / 1000)).toFixed(1)) : null,
            tokenCountEstimated: outputTokens == null,
            attemptCount: handle.diagnostics?.attemptCount ?? 1,
            attemptedTargets: handle.diagnostics?.attemptedTargets ?? [`${handle.provider}:${handle.model}`],
            thinkingLevel: handle.diagnostics?.thinkingLevel,
            serviceTierRequested: handle.diagnostics?.serviceTierRequested,
            serviceTierActual,
            ...params.preGenerationMetrics,
          };

          console.info(JSON.stringify({ event: "completion.metrics", ...metrics }));
          controller.enqueue(sse("metrics", metrics));
          controller.enqueue(sse("done", { requestId: params.requestId }));
        } catch (error: any) {
          if (!cancelled) {
            console.error(`[completion:${params.requestId}] stream failed`, error);
            try {
              controller.enqueue(
                sse("error", {
                  message: "The model request failed or the stream was interrupted. Please retry.",
                  details: error?.message,
                }),
              );
            } catch {
              // The browser may have disconnected while the provider call was still pending.
            }
          }
        } finally {
          try {
            controller.close();
          } catch {
            // Client may have disconnected/aborted; closing an already-cancelled stream is harmless.
          }
        }
      };

      void run();
    },
    cancel() {
      cancelled = true;
      // Provider SDK cancellation is not universally available, but downstream chunks are discarded immediately.
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
