import { NextResponse } from "next/server";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import type { MeetingMemory, TranscriptTurn } from "@/lib/conversationTypes";
import { EMPTY_MEETING_MEMORY } from "@/lib/conversationTypes";
import { normalizeCallType } from "@/lib/callTypes";
import { buildMemoryUserPrompt, getMemorySystemPrompt } from "@/lib/prompts/memory";

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
  try {
    const body = await request.json();
    const previous: MeetingMemory = body?.previousMemory || EMPTY_MEETING_MEMORY;
    const turns: TranscriptTurn[] = Array.isArray(body?.turns) ? body.turns.slice(-30) : [];
    const callType = normalizeCallType(body?.sessionInfo?.callType);

    if (turns.length === 0) return NextResponse.json({ memory: previous });
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY is not configured" }, { status: 500 });

    const remoteLabel = callType === "taking_interview" ? "candidate" : callType === "meeting" ? "remote" : "interviewer";
    const safeTurns = turns.map((turn) => ({
      speaker: turn.speaker === "me" ? "me" : remoteLabel,
      text: String(turn.text || "").slice(0, 1_500),
    }));

    const prompt = buildMemoryUserPrompt(previous, safeTurns);

    const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: process.env.GEMINI_API_VERSION || "v1" } });
    const response = await client.models.generateContent({
      model: process.env.MEMORY_MODEL || "gemini-3.5-flash-lite",
      contents: prompt,
      config: {
        systemInstruction: getMemorySystemPrompt(callType),
        responseMimeType: "application/json",
        maxOutputTokens: 1_000,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    });

    const text = response.text?.trim();
    if (!text) throw new Error("Memory model returned an empty response");
    return NextResponse.json({ memory: sanitizeMemory(JSON.parse(text)) });
  } catch (error: any) {
    console.error("[memory] update failed", error);
    return NextResponse.json({ error: error?.message || "Failed to update meeting memory" }, { status: 500 });
  }
}
