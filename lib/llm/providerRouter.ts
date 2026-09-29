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
  return [404, 408, 429, 500, 502, 503, 504].includes(error.status);
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
      ? process.env.GEMINI_MODEL || "gemini-3.5-flash"
      : primaryProvider === "cerebras"
        ? process.env.CEREBRAS_MODEL || "gpt-oss-120b"
        : process.env.GROQ_MODEL || "qwen/qwen3.8-27b";

  const result: ProviderTarget[] = [{ provider: primaryProvider, model: primaryModel }];

  if (primaryProvider === "gemini" && process.env.GEMINI_FALLBACK_MODEL) {
    result.push({ provider: "gemini", model: process.env.GEMINI_FALLBACK_MODEL });
  }

  if (process.env.LLM_FALLBACK_PROVIDER) {
    const fallbackProvider = parseProvider(process.env.LLM_FALLBACK_PROVIDER);
    if (fallbackProvider !== primaryProvider || result.length === 1) {
      const fallbackModel =
        fallbackProvider === "gemini"
          ? process.env.GEMINI_MODEL || "gemini-3.5-flash"
          : fallbackProvider === "cerebras"
            ? process.env.CEREBRAS_MODEL || "gpt-oss-120b"
            : process.env.GROQ_MODEL || "qwen/qwen3.8-27b";
      result.push({ provider: fallbackProvider, model: fallbackModel });
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
    return createGeminiStream(prompt, target.model || process.env.GEMINI_MODEL || "gemini-3.5-flash", options);
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

/**
 * Fire all configured providers in parallel and return whatever connects.
 * Each entry in the result has a `slot` label ("A" or "B") for the frontend.
 */
export interface ParallelStreamHandle extends LLMStreamHandle {
  slot: "A" | "B";
}

export async function createParallelLLMStreams(
  prompt: string,
  options: LLMRequestOptions = {},
): Promise<ParallelStreamHandle[]> {
  const allTargets = targets();
  if (allTargets.length === 0) throw new Error("No LLM provider is configured");

  const slots: Array<"A" | "B"> = ["A", "B"];
  const results = await Promise.allSettled(
    allTargets.map((target, index) =>
      createStreamForTarget(target, prompt, options).then<ParallelStreamHandle>((handle) => {
        markSuccess(target);
        handle.diagnostics = {
          ...(handle.diagnostics || { attemptCount: 1, attemptedTargets: [] }),
          attemptCount: 1,
          attemptedTargets: [keyOf(target)],
        };
        return { ...handle, slot: slots[index] || "B" };
      }),
    ),
  );

  const handles: ParallelStreamHandle[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") handles.push(result.value);
  }

  if (handles.length === 0) {
    const firstError = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    throw firstError?.reason instanceof Error ? firstError.reason : new Error("All LLM providers failed to connect");
  }

  return handles;
}

