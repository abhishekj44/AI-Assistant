import { createLLMStream } from "@/lib/llm/providerRouter";
import { retrieveContext } from "@/lib/server/retrieval";
import { selectCandidateContext } from "@/lib/knowledge/contextSelector";
import { chatRepository, createChatHandlers } from "@/lib/server/repositories/chatRepository";
import { promptRepository } from "@/lib/server/repositories/promptRepository";

export const runtime = "nodejs";

async function candidateContext(message: string): Promise<string> {
  try {
    const knowledge = await retrieveContext(message, "");
    return selectCandidateContext(knowledge.pack, message, "", 2000);
  } catch { return ""; }
}
const handlers = createChatHandlers({ chats: chatRepository, prompts: promptRepository, generate: createLLMStream, context: candidateContext });
export const GET = handlers.GET;
export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
