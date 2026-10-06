import { NextResponse } from "next/server";
import { GoogleGenAI, ThinkingLevel, type GenerateContentParameters } from "@google/genai";
import type { MeetingMemory, TranscriptTurn } from "@/lib/conversationTypes";
import { EMPTY_MEETING_MEMORY } from "@/lib/conversationTypes";
import { normalizeCallType } from "@/lib/callTypes";
import { renderRuntimePrompt } from "@/lib/server/runtimePrompts";
import { ModelRunRepository } from "@/lib/server/repositories/modelRunRepository";
import { sessionRepository } from "@/lib/server/repositories/sessionRepository";
import { promptRepository } from "@/lib/server/repositories/promptRepository";
import { interviewContextBlock } from "@/lib/interviewContext";

export const runtime = "nodejs";

function strings(value: unknown, max = 30): string[] {
  return Array.isArray(value)
    ? value.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, max)
    : [];
}

function sanitizeMemory(value: any): MeetingMemory {
  return {
    summary: typeof value?.summary === "string" ? value.summary.trim().slice(0, 2_500) : "",
    currentTopic: typeof value?.currentTopic === "string" ? value.currentTopic.trim().slice(0, 250) : undefined,
    facts: strings(value?.facts),
    decisions: strings(value?.decisions),
    openQuestions: strings(value?.openQuestions),
    entities: strings(value?.entities),
    updatedAt: new Date().toISOString(),
  };
}

export async function POST(request: Request) {
  let runs: ModelRunRepository | undefined;
  let runId: string | undefined;
  let output = "";
  try {
    const body = await request.json();
    const previous: MeetingMemory = body?.previousMemory || EMPTY_MEETING_MEMORY;
    const turns: TranscriptTurn[] = Array.isArray(body?.turns) ? body.turns.slice(-30) : [];
    const callType = normalizeCallType(body?.sessionInfo?.callType);

    if (turns.length === 0) return NextResponse.json({ memory: previous });
    const dependencies = POST.dependencies();
    const remoteLabel = callType === "taking_interview" ? "candidate" : callType === "meeting" ? "remote" : "interviewer";
    const safeTurns = turns.map((turn) => ({
      speaker: turn.speaker === "me" ? "me" : remoteLabel,
      text: String(turn.text || "").slice(0, 1_500),
    }));

    const rendered = renderRuntimePrompt("MEMORY", body?.sessionInfo, {
      previousMemory: JSON.stringify(previous), recentTurns: JSON.stringify(safeTurns),
      jobDescription: body.sessionInfo?.callType === "giving_interview" ? String(body.sessionInfo?.jobDescription || "").slice(0, 12_000) : "",
      candidateProfile: body.sessionInfo?.callType === "taking_interview" ? String(body.sessionInfo?.candidateProfile || "").slice(0, 12_000) : "",
    }, dependencies.prompts);
    const prompt = [rendered.prompt, interviewContextBlock(body.sessionInfo)].filter(Boolean).join("\n\n");
    const systemInstruction = `${rendered.systemInstruction}\n\nCODE-OWNED OUTPUT CONTRACT: Return valid JSON only with this shape:\n{"summary":"...","currentTopic":"...","facts":[],"decisions":[],"openQuestions":[],"entities":[]}`;
    const sessionId = typeof body?.sessionId === "string" && dependencies.sessions.get(body.sessionId, false) ? body.sessionId : undefined;
    runs = dependencies.runs;
    const requestId = runs.createRequest({ ...rendered, prompt, systemInstruction, mode: rendered.mode ?? undefined, sessionId, purpose: "MEMORY", context: { previousMemory: previous, sessionInfo: body.sessionInfo, recentTurns: safeTurns, promptVersion: rendered.promptVersion } });
    const model = process.env.MEMORY_MODEL || "gemini-3.5-flash-lite";
    runId = runs.start({ requestId, provider: "gemini", model, tag: "Rolling Memory" });
    request.signal.throwIfAborted();

    const response = await dependencies.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction,
        abortSignal: request.signal,
        httpOptions: { timeout: 30_000 },
        responseMimeType: "application/json",
        maxOutputTokens: 1_000,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    });

    output = response.text?.trim() ?? "";
    request.signal.throwIfAborted();
    if (!output) throw new Error("Memory model returned an empty response");
    const parsed: unknown = JSON.parse(output);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Memory model returned invalid memory JSON");
    const value = parsed as Record<string, unknown>;
    if (typeof value.summary !== "string" || (value.currentTopic !== undefined && typeof value.currentTopic !== "string") || ["facts", "decisions", "openQuestions", "entities"].some(key => !Array.isArray(value[key]) || !(value[key] as unknown[]).every(item => typeof item === "string"))) {
      throw new Error("Memory model returned invalid memory JSON");
    }
    const memory = sanitizeMemory(value);
    if (sessionId && typeof body.ownerTabId === "string" && Number.isSafeInteger(body.coveredThroughSequence)) {
      dependencies.sessions.updateMemory(sessionId, memory, body.coveredThroughSequence, body.ownerTabId);
    }
    runs.finish(runId, { status: "COMPLETED", output });
    return NextResponse.json({ memory });
  } catch (error: any) {
    if (runId) runs!.finish(runId, { status: request.signal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError" ? "INTERRUPTED" : "FAILED", output, error: error?.message || String(error) });
    console.error("[memory] update failed", error);
    return NextResponse.json({ error: error?.message || "Failed to update meeting memory" }, { status: 500 });
  }
}

POST.dependencies = () => ({
  prompts: promptRepository,
  sessions: sessionRepository,
  runs: new ModelRunRepository(),
  generateContent: async (parameters: GenerateContentParameters): Promise<{ text?: string }> => {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");
    const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: process.env.GEMINI_API_VERSION || "v1" } });
    return client.models.generateContent(parameters);
  },
});
