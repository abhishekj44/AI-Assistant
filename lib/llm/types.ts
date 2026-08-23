export type LLMProviderName = "gemini" | "cerebras" | "groq";

export interface LLMRequestOptions {
  maxOutputTokens?: number;
  sessionId?: string;
  systemInstruction?: string;
}

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  thoughtTokens?: number;
  serviceTierActual?: string;
}

export interface LLMStreamDelta {
  text?: string;
  usage?: LLMUsage;
}

export interface LLMStreamDiagnostics {
  attemptCount: number;
  attemptedTargets: string[];
  thinkingLevel?: string;
  serviceTierRequested?: "standard" | "priority";
}

export interface LLMStreamHandle {
  provider: LLMProviderName;
  model: string;
  stream: AsyncIterable<LLMStreamDelta>;
  diagnostics?: LLMStreamDiagnostics;
}

export class LLMProviderError extends Error {
  status?: number;
  provider: LLMProviderName;
  model: string;
  body?: string;

  constructor(params: {
    message: string;
    provider: LLMProviderName;
    model: string;
    status?: number;
    body?: string;
  }) {
    super(params.message);
    this.name = "LLMProviderError";
    this.provider = params.provider;
    this.model = params.model;
    this.status = params.status;
    this.body = params.body;
  }
}
