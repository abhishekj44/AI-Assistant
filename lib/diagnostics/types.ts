export interface CompletionMetrics {
  provider?: string;
  model?: string;
  clientTtftMs?: number;
  clientResponseHeadersMs?: number;
  clientFirstSseMs?: number;
  clientTotalMs?: number;
  serverTtftMs?: number | null;
  firstChunkServerMs?: number | null;
  preModelMs?: number;
  modelConnectMs?: number;
  firstChunkDelayMs?: number | null;
  modelWaitMs?: number;
  generationMs?: number;
  tokensPerSecond?: number | null;
  totalMs?: number;
  requestParseMs?: number;
  sanitizeMs?: number;
  questionDeriveMs?: number;
  knowledgeReadMs?: number;
  knowledgeCacheHit?: boolean;
  contextMs?: number;
  selectorMs?: number;
  promptBuildMs?: number;
  webMs?: number;
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
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheHitPercent?: number | null;
  thoughtTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  tokenCountEstimated?: boolean;
  attemptCount?: number;
  attemptedTargets?: string[];
  thinkingLevel?: string;
  serviceTierRequested?: string;
  serviceTierActual?: string;
}

export interface QAMatchSnapshot {
  id: string;
  category?: string;
  score: number;
  matchedQuestion?: string;
  primaryQuestion: string;
  preparedAnswer: string;
  keyPoints: string[];
  tags: string[];
  personal: boolean;
}

export interface CompletionContextSnapshot {
  requestId: string;
  createdAt: string;
  question: string;
  candidate: {
    selectedContext: string;
    rawChars: number;
    selectedChars: number;
    budgetChars: number;
    compressionRatio: number | null;
    selectedProjects: string[];
    selectedExperience: string[];
    broadPersonalQuestion: boolean;
    topProjectName?: string;
    topProjectScore?: number;
    projectEvidenceRequired: boolean;
    projectExampleIncluded: boolean;
    selectedExampleTitles: string[];
  };
  answerProfile: {
    mode: string;
    minWords: number;
    maxWords: number;
    maxOutputTokens: number;
    requestProjectExample: boolean;
    rationale: string;
  };
  qna: {
    bankEntries: number;
    strongMatch: boolean;
    matches: QAMatchSnapshot[];
    guidance: string;
  };
  meetingMemoryText: string;
  recentConversationText: string;
  candidateNotes: string;
  webContextText: string;
  systemInstruction: string;
  prompt: string;
  promptChars: number;
  systemInstructionChars: number;
}
