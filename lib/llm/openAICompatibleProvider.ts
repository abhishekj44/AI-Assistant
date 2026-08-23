import type { LLMProviderName, LLMRequestOptions, LLMStreamHandle, LLMUsage } from "./types";
import { LLMProviderError } from "./types";

interface ProviderConfig {
  provider: Exclude<LLMProviderName, "gemini">;
  apiKey: string;
  endpoint: string;
  model: string;
}

function getConfig(provider: "cerebras" | "groq", modelOverride?: string): ProviderConfig {
  if (provider === "cerebras") {
    const apiKey = process.env.CEREBRAS_API_KEY?.trim();
    if (!apiKey) throw new Error("CEREBRAS_API_KEY is not configured");
    return {
      provider,
      apiKey,
      endpoint: process.env.CEREBRAS_API_URL || "https://api.cerebras.ai/v1/chat/completions",
      model: modelOverride || process.env.CEREBRAS_MODEL || "gpt-oss-120b",
    };
  }

  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured");
  return {
    provider,
    apiKey,
    endpoint: process.env.GROQ_API_URL || "https://api.groq.com/openai/v1/chat/completions",
    model: modelOverride || process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  };
}

function parseUsage(value: any): LLMUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const inputTokens = value.prompt_tokens ?? value.input_tokens;
  const outputTokens = value.completion_tokens ?? value.output_tokens;
  const totalTokens = value.total_tokens;
  if (inputTokens == null && outputTokens == null && totalTokens == null) return undefined;
  return { inputTokens, outputTokens, totalTokens };
}

function parseSSELine(line: string): { text?: string; usage?: LLMUsage } | undefined {
  const normalized = line.trim();
  if (!normalized.startsWith("data:")) return undefined;
  const payload = normalized.slice(5).trim();
  if (!payload || payload === "[DONE]") return undefined;

  try {
    const parsed = JSON.parse(payload);
    const text = parsed.choices?.[0]?.delta?.content;
    const usage = parseUsage(parsed.usage);
    return text || usage ? { text, usage } : undefined;
  } catch {
    // Ignore malformed/non-JSON SSE control lines. Provider errors are surfaced by HTTP status.
    return undefined;
  }
}

async function* parseSSE(response: Response): AsyncGenerator<{ text?: string; usage?: LLMUsage }> {
  if (!response.body) throw new Error("LLM provider returned no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary: number;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      const parsed = parseSSELine(line);
      if (parsed) yield parsed;
    }
  }

  // Flush any provider frame that was not newline-terminated.
  buffer += decoder.decode();
  const parsed = parseSSELine(buffer);
  if (parsed) yield parsed;
}

export async function createOpenAICompatibleStream(
  provider: "cerebras" | "groq",
  prompt: string,
  options: LLMRequestOptions = {},
  modelOverride?: string,
): Promise<LLMStreamHandle> {
  const config = getConfig(provider, modelOverride);
  const requestBody: Record<string, unknown> = {
    model: config.model,
    messages: [
      ...(options.systemInstruction ? [{ role: "system", content: options.systemInstruction }] : []),
      { role: "user", content: prompt },
    ],
    stream: true,
    max_completion_tokens: options.maxOutputTokens ?? 320,
  };
  if (/gpt-oss/i.test(config.model)) requestBody.reasoning_effort = "low";

  // These are optional optimizations; only send them when explicitly enabled.
  if (provider === "cerebras" && process.env.CEREBRAS_PROMPT_CACHE_ENABLED === "true" && options.sessionId) {
    requestBody.prompt_cache_key = options.sessionId;
  }
  if (provider === "groq") {
    requestBody.stream_options = { include_usage: true };
  }
  if (provider === "groq" && process.env.GROQ_SERVICE_TIER) {
    requestBody.service_tier = process.env.GROQ_SERVICE_TIER;
  }

  let response: Response;
  try {
    response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout((() => {
        const parsed = Number(process.env.LLM_CONNECT_TIMEOUT_MS);
        return Number.isFinite(parsed) ? Math.max(1_000, Math.min(Math.round(parsed), 20_000)) : 8_000;
      })()),
    });
  } catch (error: any) {
    throw new LLMProviderError({
      message: error?.message || `${provider} connection failed`,
      provider,
      model: config.model,
    });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new LLMProviderError({
      message: `${provider} returned HTTP ${response.status}`,
      provider,
      model: config.model,
      status: response.status,
      body: body.slice(0, 2_000),
    });
  }

  return { provider, model: config.model, stream: parseSSE(response) };
}
