import gemini, { GEMINI_MODEL, GEMINI_MODEL_FAST, GEMINI_FALLBACK_MODELS } from "@/lib/gemini";
import { ragOrchestrator } from "@/lib/agents/ragOrchestrator";
import { FLAGS } from "@/lib/types";
import {
  buildPrompt,
  buildRAGPrompt,
  buildSummerizerPrompt,
  type TranscriptTurn,
} from "@/lib/utils";

export const runtime = "nodejs";

/** Max time (ms) for the entire POST handler before we abort. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Max retries for transient Gemini errors (503, 429). */
const MAX_RETRIES = 3;

/** Base delay (ms) for exponential backoff. */
const BASE_DELAY_MS = 800;

function unavailableResponse(details?: string) {
  return Response.json(
    { error: "Gemini is currently unavailable. Please try again in a moment.", details },
    { status: 503 },
  );
}

/**
 * Sleep helper for retry backoff.
 */
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error is retryable (transient server / rate-limit errors / model errors).
 */
function isRetryable(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as any).status ?? (error as any).statusCode;
    if (status === 503 || status === 429 || status === 500 || status === 404) return true;
    const msg = (error as any).message ?? "";
    if (/unavailable|overloaded|rate.?limit|high demand|not found|resource_exhausted/i.test(msg)) return true;
  }
  return false;
}

/**
 * Create a streaming response from Gemini with retry + model fallbacks.
 */
async function streamResponse(prompt: string, citations?: unknown[]) {
  const modelsToTry = [GEMINI_MODEL, GEMINI_MODEL_FAST, ...GEMINI_FALLBACK_MODELS.filter(m => m !== GEMINI_MODEL && m !== GEMINI_MODEL_FAST)];

  let lastError: any = null;

  for (let attempt = 0; attempt < modelsToTry.length; attempt++) {
    const model = modelsToTry[attempt];
    try {
      // First try with maxOutputTokens: 400
      const stream = await gemini.models.generateContentStream({
        model,
        contents: prompt,
        config: {
          temperature: 0.7,
          maxOutputTokens: 1200,
        },
      });

      const encoder = new TextEncoder();

      return new Response(
        new ReadableStream({
          async start(controller) {
            try {
              let hasContent = false;
              for await (const chunk of stream) {
                if (chunk.text) {
                  hasContent = true;
                  controller.enqueue(encoder.encode(chunk.text));
                }
              }

              if (!hasContent) {
                controller.enqueue(
                  encoder.encode("Sorry, I could not generate a response at this time."),
                );
              }
              if (citations?.length) {
                controller.enqueue(
                  encoder.encode(
                    `\n\n---SOURCES---\n${JSON.stringify({ type: "citations", citations })}`,
                  ),
                );
              }
              controller.close();
            } catch (streamError) {
              console.error("Gemini stream chunk error:", (streamError as any)?.status ?? streamError);
              try {
                controller.enqueue(
                  encoder.encode(
                    "\n\n⚠️ The AI response was interrupted. Please try again.",
                  ),
                );
                controller.close();
              } catch {
                // Controller closed
              }
            }
          },
        }),
        { headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    } catch (error: any) {
      lastError = error;
      console.warn(`Gemini attempt with model ${model} failed (${error?.status || error?.message}), trying fallback...`);
      if (attempt < modelsToTry.length - 1) {
        await sleep(BASE_DELAY_MS);
        continue;
      }
    }
  }

  console.error("All Gemini model attempts exhausted:", lastError?.message || lastError);
  return unavailableResponse(lastError?.message);
}

export async function POST(req: Request) {
  const { bg, flag, prompt: transcript, summary, focusQuestion, recentTurns, customRules } = await req.json();

  // Cast recentTurns to typed array (sent as JSON from client)
  const typedTurns: TranscriptTurn[] | undefined = recentTurns;

  if (flag === FLAGS.SUMMERIZER) {
    return streamResponse(buildSummerizerPrompt(transcript));
  }
  if (flag !== FLAGS.COPILOT) {
    return Response.json({ error: "Invalid request flag" }, { status: 400 });
  }

  // Use RAG with a global timeout to prevent hanging requests.
  try {
    const ragResult = await Promise.race([
      ragOrchestrator.processTranscript(transcript, bg, focusQuestion),
      sleep(REQUEST_TIMEOUT_MS).then(() => null),
    ]);

    if (ragResult && ragResult.searchPerformed && ragResult.extractedQuestion) {
      return streamResponse(
        buildRAGPrompt(
          bg,
          transcript,
          ragResult.extractedQuestion.question,
          ragResult.context.combinedContext,
          summary,
          typedTurns,
          customRules,
        ),
        ragResult.context.citations,
      );
    }
  } catch (error) {
    console.error("RAG processing error:", (error as Error).message);
    // Fall through to direct response — don't crash.
  }

  return streamResponse(buildPrompt(bg, transcript, summary, typedTurns, customRules));
}

