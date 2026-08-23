import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { LLMRequestOptions, LLMStreamHandle } from "./types";
import { LLMProviderError } from "./types";

function requireApiKey(): string {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("GEMINI_API_KEY is not configured");
  return key;
}

function getThinkingLevel(): { sdk: ThinkingLevel; label: string } {
  const configured = (process.env.GEMINI_THINKING_LEVEL || "minimal").toLowerCase();
  switch (configured) {
    case "low":
      return { sdk: ThinkingLevel.LOW, label: "low" };
    case "medium":
      return { sdk: ThinkingLevel.MEDIUM, label: "medium" };
    case "high":
      return { sdk: ThinkingLevel.HIGH, label: "high" };
    case "minimal":
    default:
      return { sdk: ThinkingLevel.MINIMAL, label: "minimal" };
  }
}

function getServiceTier(): "standard" | "priority" {
  return (process.env.GEMINI_SERVICE_TIER || "standard").toLowerCase() === "priority"
    ? "priority"
    : "standard";
}

export async function createGeminiStream(
  prompt: string,
  model: string,
  options: LLMRequestOptions = {},
): Promise<LLMStreamHandle> {
  const client = new GoogleGenAI({
    apiKey: requireApiKey(),
    httpOptions: { apiVersion: process.env.GEMINI_API_VERSION || "v1" },
  });
  const thinking = getThinkingLevel();
  const serviceTier = getServiceTier();

  try {
    // Keep the request object intentionally structural so newer SDK fields such as
    // serviceTier can be used without coupling this file to one generated type shape.
    const config: any = {
      maxOutputTokens: options.maxOutputTokens ?? 320,
      systemInstruction: options.systemInstruction,
      thinkingConfig: {
        thinkingLevel: thinking.sdk,
      },
    };
    if (serviceTier === "priority") config.serviceTier = "priority";

    const request: any = {
      model,
      contents: prompt,
      config,
    };

    const response = await client.models.generateContentStream(request);

    const stream = async function* () {
      for await (const chunk of response) {
        const text = chunk.text || undefined;
        const usageMetadata = chunk.usageMetadata as any;
        const usage = usageMetadata
          ? {
              inputTokens: usageMetadata.promptTokenCount,
              outputTokens: usageMetadata.responseTokenCount ?? usageMetadata.candidatesTokenCount,
              totalTokens: usageMetadata.totalTokenCount,
              cachedInputTokens: usageMetadata.cachedContentTokenCount,
              thoughtTokens: usageMetadata.thoughtsTokenCount,
              serviceTierActual: usageMetadata.serviceTier ? String(usageMetadata.serviceTier).toLowerCase() : undefined,
            }
          : undefined;
        if (text || usage) yield { text, usage };
      }
    };

    return {
      provider: "gemini",
      model,
      stream: stream(),
      diagnostics: {
        attemptCount: 1,
        attemptedTargets: [`gemini:${model}`],
        thinkingLevel: thinking.label,
        serviceTierRequested: serviceTier,
      },
    };
  } catch (error: any) {
    throw new LLMProviderError({
      message: error?.message || "Gemini request failed",
      provider: "gemini",
      model,
      status: error?.status ?? error?.statusCode,
      body: error?.response?.data ? JSON.stringify(error.response.data) : undefined,
    });
  }
}
