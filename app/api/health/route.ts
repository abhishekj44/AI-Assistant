import { NextResponse } from "next/server";
import { readKnowledgePack } from "@/lib/server/knowledgeStore";
import { readQABank } from "@/lib/server/qaStore";

export const runtime = "nodejs";

export async function GET() {
  const provider = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
  const configured =
    provider === "cerebras"
      ? Boolean(process.env.CEREBRAS_API_KEY)
      : provider === "groq"
        ? Boolean(process.env.GROQ_API_KEY)
        : Boolean(process.env.GEMINI_API_KEY);
  const [pack, qaBank] = await Promise.all([readKnowledgePack(), readQABank()]);

  return NextResponse.json({
    ok: configured && Boolean(process.env.DEEPGRAM_API_KEY),
    llm: {
      provider,
      configured,
      model:
        provider === "cerebras"
          ? process.env.CEREBRAS_MODEL || "gpt-oss-120b"
          : provider === "groq"
            ? process.env.GROQ_MODEL || "openai/gpt-oss-120b"
            : process.env.GEMINI_MODEL || "gemini-3.6-flash",
      ...(provider === "gemini"
        ? {
            thinkingLevel: process.env.GEMINI_THINKING_LEVEL || "minimal",
            serviceTier: process.env.GEMINI_SERVICE_TIER || "standard",
          }
        : {}),
    },
    deepgramConfigured: Boolean(process.env.DEEPGRAM_API_KEY),
    webSearchConfigured: Boolean(process.env.TAVILY_API_KEY),
    knowledgeSources: pack.sources.length,
    qaBankEntries: qaBank.entries.length,
  });
}
