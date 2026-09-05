import { createLLMStream } from "@/lib/llm/providerRouter";
import { LLMProviderError } from "@/lib/llm/types";
import { readKnowledgePackWithMeta } from "@/lib/server/knowledgeStore";
import { selectCandidateContext } from "@/lib/knowledge/contextSelector";

export const runtime = "nodejs";

const CHAT_SYSTEM_INSTRUCTION = `You are a helpful, versatile AI Assistant and Copilot embedded in an interview preparation and meeting platform.

You have access to the user's Candidate Knowledge (profile, projects, skills, experience) when relevant.

How to respond:
1. General Questions & Conversations:
   - Answer the user's actual question directly, conversationally, and concisely.
   - Do NOT format regular questions into the "Interviewer Evaluation & Follow-up" format. Provide direct, helpful answers.

2. Technical & Architecture Questions:
   - Answer technical queries (Python, FastAPI, Temporal, RAG, Vector DBs, AI Agents, System Design, OAuth/Security, etc.) with senior engineering depth, clarity, and practical trade-offs.

3. Questions About Candidate Background:
   - When asked about projects, experience, or skills, use the facts from CANDIDATE_KNOWLEDGE. Be accurate and never invent personal claims.

4. Candidate Evaluation (ONLY when explicitly asked):
   - ONLY if the user explicitly asks you to evaluate a candidate's response or generate interview follow-up questions for a candidate's statement, format your response into:
     - 🔍 Candidate Answer Evaluation & Technical Fact-Check
     - 🎯 Primary Follow-Up Question
     - 🔀 Topic-Switch Follow-Up Question

Tone:
- Direct, intelligent, and conversational.
- Use clean markdown formatting (bullet points, bold text, code blocks) when helpful.`;

interface ChatMessage {
  sender: "user" | "bot";
  text: string;
}

function sanitizeHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-20)
    .map((msg: unknown): ChatMessage | null => {
      if (!msg || typeof msg !== "object") return null;
      const raw = msg as Record<string, unknown>;
      const sender = raw.sender === "user" || raw.sender === "bot" ? raw.sender : null;
      const text = typeof raw.text === "string" ? raw.text.trim().slice(0, 2_000) : "";
      if (!sender || !text) return null;
      return { sender, text };
    })
    .filter((msg): msg is ChatMessage => msg !== null);
}

function buildChatPrompt(
  history: ChatMessage[],
  currentMessage: string,
  candidateContext: string,
): string {
  const blocks: string[] = [];

  if (candidateContext) {
    blocks.push(`<CANDIDATE_KNOWLEDGE>\n${candidateContext}\n</CANDIDATE_KNOWLEDGE>`);
  }

  if (history.length > 0) {
    const formatted = history
      .map((msg) => `${msg.sender === "user" ? "USER" : "ASSISTANT"}: ${msg.text}`)
      .join("\n");
    blocks.push(`<CONVERSATION_HISTORY>\n${formatted}\n</CONVERSATION_HISTORY>`);
  }

  blocks.push(`USER: ${currentMessage.trim()}`);
  blocks.push("Respond helpfully and concisely as the ASSISTANT.");

  return blocks.join("\n\n");
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const message = typeof body?.message === "string" ? body.message.trim().slice(0, 2_000) : "";
    if (!message) {
      return Response.json({ error: "Message is required" }, { status: 400 });
    }

    const history = sanitizeHistory(body?.history);

    // Load candidate knowledge for context (cached, ~0ms after first call)
    let candidateContext = "";
    try {
      const knowledge = await readKnowledgePackWithMeta();
      candidateContext = selectCandidateContext(knowledge.pack, message, "", 2_000);
    } catch {
      // Non-fatal: continue without candidate context
    }

    const prompt = buildChatPrompt(history, message, candidateContext);

    // Collect the full response (non-streaming for simplicity)
    const handle = await createLLMStream(prompt, {
      maxOutputTokens: 800,
      systemInstruction: CHAT_SYSTEM_INSTRUCTION,
    });

    let reply = "";
    for await (const chunk of handle.stream) {
      if (chunk.text) reply += chunk.text;
    }

    reply = reply.trim() || "I couldn't generate a response. Please try again.";

    return Response.json({ reply });
  } catch (error: any) {
    console.error("[chat] request failed", error);
    const status = error instanceof LLMProviderError && error.status && error.status < 500 ? error.status : 503;
    return Response.json(
      { error: "Unable to generate a response", details: error?.message },
      { status },
    );
  }
}
