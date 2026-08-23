import { createGeminiStream } from "./geminiProvider";
import { createOpenAICompatibleStream } from "./openAICompatibleProvider";
import type { LLMProviderName, LLMRequestOptions, LLMStreamHandle } from "./types";
import { LLMProviderError } from "./types";

interface ProviderTarget {
  provider: LLMProviderName;
  model?: string;
}

const health = new Map<string, { failures: number; openUntil: number }>();
const CIRCUIT_FAILURE_THRESHOLD = 2;
const CIRCUIT_OPEN_MS = 30_000;

function isTransient(error: unknown): boolean {
  if (!(error instanceof LLMProviderError)) return false;
  if (error.status == null) return true;
  return [429, 500, 502, 503, 504].includes(error.status);
}

function keyOf(target: ProviderTarget): string {
  return `${target.provider}:${target.model || "default"}`;
}

function isCircuitOpen(target: ProviderTarget): boolean {
  const state = health.get(keyOf(target));
  return Boolean(state && state.openUntil > Date.now());
}

function markSuccess(target: ProviderTarget) {
  health.delete(keyOf(target));
}

function markTransientFailure(target: ProviderTarget) {
  const key = keyOf(target);
  const previous = health.get(key) || { failures: 0, openUntil: 0 };
  const failures = previous.failures + 1;
  health.set(key, {
    failures,
    openUntil: failures >= CIRCUIT_FAILURE_THRESHOLD ? Date.now() + CIRCUIT_OPEN_MS : 0,
  });
}

function parseProvider(value?: string): LLMProviderName {
  const normalized = (value || "gemini").toLowerCase();
  if (normalized === "cerebras" || normalized === "groq" || normalized === "gemini") return normalized;
  return "gemini";
}

function targets(): ProviderTarget[] {
  const primaryProvider = parseProvider(process.env.LLM_PROVIDER);
  const primaryModel =
    primaryProvider === "gemini"
      ? process.env.GEMINI_MODEL || "gemini-3.6-flash"
      : primaryProvider === "cerebras"
        ? process.env.CEREBRAS_MODEL || "gpt-oss-120b"
        : process.env.GROQ_MODEL || "openai/gpt-oss-120b";

  const result: ProviderTarget[] = [{ provider: primaryProvider, model: primaryModel }];

  if (primaryProvider === "gemini" && process.env.GEMINI_FALLBACK_MODEL) {
    result.push({ provider: "gemini", model: process.env.GEMINI_FALLBACK_MODEL });
  }

  if (process.env.LLM_FALLBACK_PROVIDER) {
    const fallbackProvider = parseProvider(process.env.LLM_FALLBACK_PROVIDER);
    if (fallbackProvider !== primaryProvider || result.length === 1) {
      result.push({ provider: fallbackProvider });
    }
  }

  return result.slice(0, 2);
}

async function createStreamForTarget(
  target: ProviderTarget,
  prompt: string,
  options: LLMRequestOptions,
): Promise<LLMStreamHandle> {
  if (target.provider === "gemini") {
    return createGeminiStream(prompt, target.model || "gemini-3.6-flash", options);
  }
  return createOpenAICompatibleStream(target.provider, prompt, options, target.model);
}

export async function createLLMStream(
  prompt: string,
  options: LLMRequestOptions = {},
): Promise<LLMStreamHandle> {
  let lastError: unknown;
  const attemptedTargets: string[] = [];

  for (const target of targets()) {
    if (isCircuitOpen(target)) continue;
    attemptedTargets.push(keyOf(target));

    try {
      const handle = await createStreamForTarget(target, prompt, options);
      markSuccess(target);
      handle.diagnostics = {
        ...(handle.diagnostics || { attemptCount: 1, attemptedTargets: [] }),
        attemptCount: attemptedTargets.length,
        attemptedTargets: [...attemptedTargets],
      };
      return handle;
    } catch (error) {
      lastError = error;
      if (!isTransient(error)) throw error;
      markTransientFailure(target);
      console.warn(`[llm] transient failure for ${keyOf(target)}; trying configured fallback`, error);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("No healthy LLM provider is configured");
}
