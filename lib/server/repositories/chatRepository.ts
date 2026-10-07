import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDatabase } from "../db/connection";
import { ModelRunRepository, type ModelRequestInput } from "./modelRunRepository";
import type { LLMStreamHandle, LLMRequestOptions } from "../../llm/types";
import type { PromptRepository } from "./promptRepository";
import { renderRuntimePrompt } from "../runtimePrompts";

export interface ChatThread { id: string; session_id: string | null; title: string; created_at: string; updated_at: string }
export interface ChatMessage { id: string; thread_id: string; role: "USER" | "ASSISTANT"; content: string; run_id: string | null; created_at: string }
export class ChatRepository {
  constructor(private readonly database?: Database.Database) {}
  private get db() { return this.database ?? getDatabase(); }
  createThread(input: { id?: string; title?: string; sessionId?: string } = {}): ChatThread {
    const id = input.id ?? randomUUID();
    if (typeof id !== "string" || !id.trim() || id.length > 200) throw new Error("Invalid thread id");
    const now = new Date().toISOString();
    this.db.prepare("INSERT OR IGNORE INTO chat_threads(id,session_id,title,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, input.sessionId ?? null, (input.title || "Chat").slice(0, 160), now, now);
    const thread = this.getThread(id);
    if (!thread) throw new Error("Thread not found");
    return thread;
  }
  listThreads(): ChatThread[] { return this.db.prepare("SELECT * FROM chat_threads ORDER BY updated_at DESC,rowid DESC").all() as ChatThread[]; }
  getThread(id: string): ChatThread | undefined { return this.db.prepare("SELECT * FROM chat_threads WHERE id=?").get(id) as ChatThread | undefined; }
  getMessages(threadId: string): ChatMessage[] {
    if (!this.getThread(threadId)) throw new Error("Thread not found");
    return this.db.prepare("SELECT * FROM chat_messages WHERE thread_id=? ORDER BY created_at,rowid").all(threadId) as ChatMessage[];
  }
  page(threadId: string, limit = 50, before?: string): { messages: ChatMessage[]; nextBefore: string | null } {
    if (!this.getThread(threadId)) throw new Error("Thread not found");
    const cursor = before ? this.db.prepare("SELECT rowid AS position FROM chat_messages WHERE id=? AND thread_id=?").get(before, threadId) as { position: number } | undefined : undefined;
    if (before && !cursor) throw new Error("Invalid message cursor");
    const size = Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.floor(limit) : 50));
    const rows = this.db.prepare("SELECT * FROM chat_messages WHERE thread_id=? AND rowid < ? ORDER BY rowid DESC LIMIT ?").all(threadId, cursor?.position ?? Number.MAX_SAFE_INTEGER, size + 1) as ChatMessage[];
    const hasMore = rows.length > size;
    const messages = rows.slice(0, size).reverse();
    return { messages, nextBefore: hasMore ? messages[0].id : null };
  }
  deleteThread(threadId: string): void {
    this.db.transaction(() => {
      const busy = this.db.prepare("SELECT 1 FROM chat_messages JOIN model_runs ON model_runs.id=chat_messages.run_id WHERE thread_id=? AND model_runs.status='RUNNING'").get(threadId);
      if (busy) throw new Error("Wait for the response before clearing chat");
      this.db.prepare("DELETE FROM chat_threads WHERE id=?").run(threadId);
    }).immediate();
  }
  getMessageRun(messageId: string) {
    const message = this.db.prepare("SELECT run_id FROM chat_messages WHERE id=?").get(messageId) as { run_id: string | null } | undefined;
    return message?.run_id ? new ModelRunRepository(this.db).get(message.run_id) : null;
  }
  claimRun(messageId: string, request: ModelRequestInput): { runId: string; status: string; output: string; claimed: boolean } {
    return this.db.transaction(() => {
      const message = this.db.prepare("SELECT * FROM chat_messages WHERE id=? AND role='USER'").get(messageId) as ChatMessage | undefined;
      if (!message) throw new Error("Message not found");
      const runs = new ModelRunRepository(this.db);
      const previous = message.run_id ? runs.get(message.run_id) : null;
      if (previous && (previous.status === "COMPLETED" || previous.status === "RUNNING")) return { runId: previous.id, status: previous.status, output: previous.output, claimed: false };
      const busy = this.db.prepare("SELECT 1 FROM chat_messages JOIN model_runs ON model_runs.id=chat_messages.run_id WHERE thread_id=? AND model_runs.status='RUNNING'").get(message.thread_id);
      if (busy) throw new Error("Thread is generating a response; retry shortly");
      const requestId = runs.createRequest({ ...request, purpose: "CHAT" });
      const runId = runs.start({ requestId, slot: "SINGLE", tag: "Chat" });
      this.db.prepare("UPDATE chat_messages SET run_id=? WHERE id=?").run(runId, messageId);
      return { runId, status: "RUNNING", output: "", claimed: true };
    }).immediate();
  }
  progress(runId: string, output: string): void { new ModelRunRepository(this.db).progress(runId, output); }
  configureRun(runId: string, provider: string, model: string): void { new ModelRunRepository(this.db).configure(runId, provider, model); }
  finishRun(runId: string, input: { status: "COMPLETED" | "INTERRUPTED" | "FAILED"; output: string; error?: string; metrics?: unknown }): void {
    new ModelRunRepository(this.db).finish(runId, input);
  }
  complete(messageId: string, runId: string, output: string, metrics?: unknown): ChatMessage {
    return this.db.transaction(() => {
      const message = this.db.prepare("SELECT * FROM chat_messages WHERE id=? AND run_id=?").get(messageId, runId) as ChatMessage | undefined;
      if (!message) throw new Error("Message run changed");
      const assistant = this.append({ id: `${messageId}:assistant`, threadId: message.thread_id, role: "ASSISTANT", content: output, runId });
      this.finishRun(runId, { status: "COMPLETED", output, metrics });
      return assistant;
    }).immediate();
  }
  append(input: { id: string; threadId: string; role: "USER" | "ASSISTANT"; content: string; runId?: string }): ChatMessage {
    if (typeof input.id !== "string" || !input.id.trim() || input.id.length > 250 || typeof input.content !== "string" || !input.content.trim() || input.content.length > 100000 || !["USER", "ASSISTANT"].includes(input.role)) throw new Error("Invalid chat message");
    return this.db.transaction(() => {
      if (!this.getThread(input.threadId)) throw new Error("Thread not found");
      const previous = this.db.prepare("SELECT * FROM chat_messages WHERE id=?").get(input.id) as ChatMessage | undefined;
      if (previous) {
        if (previous.thread_id !== input.threadId || previous.role !== input.role || previous.content !== input.content) throw new Error("Message id already used");
        return previous;
      }
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO chat_messages(id,thread_id,role,content,run_id,created_at) VALUES (?,?,?,?,?,?)").run(input.id, input.threadId, input.role, input.content, input.runId ?? null, now);
      this.db.prepare("UPDATE chat_threads SET updated_at=? WHERE id=?").run(now, input.threadId);
      return this.db.prepare("SELECT * FROM chat_messages WHERE id=?").get(input.id) as ChatMessage;
    })();
  }
}
export const chatRepository = new ChatRepository();

type ChatDependencies = { chats: ChatRepository; prompts: PromptRepository; generate: (prompt: string, options?: LLMRequestOptions) => Promise<LLMStreamHandle>; context: (message: string) => Promise<string> };
export function createChatHandlers({ chats, prompts, generate, context }: ChatDependencies) {
  return {
    async GET(request: Request) {
      try {
        const params = new URL(request.url).searchParams;
        const threadId = params.get("threadId");
        if (!threadId) return Response.json({ threads: chats.listThreads() });
        const thread = chats.getThread(threadId);
        if (!thread) return Response.json({ error: "Thread not found" }, { status: 404 });
        return Response.json({ thread, ...chats.page(threadId, Number(params.get("limit") || 50), params.get("before") || undefined) });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to restore chat" }, { status: 400 }); }
    },
    async DELETE(request: Request) {
      try {
        const threadId = new URL(request.url).searchParams.get("threadId");
        if (!threadId) return Response.json({ error: "Thread id is required" }, { status: 400 });
        chats.deleteThread(threadId);
        return Response.json({ deleted: true });
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to clear chat" }, { status: 409 }); }
    },
    async POST(request: Request) {
      let runId: string | undefined;
      let threadId: string | undefined;
      let output = "";
      try {
        const body = await request.json();
        const message = typeof body?.message === "string" ? body.message.trim() : "";
        if (!message || message.length > 2000) return Response.json({ error: "Message must contain 1 to 2000 characters" }, { status: 400 });
        if (body.threadId !== undefined && (typeof body.threadId !== "string" || !body.threadId.trim() || body.threadId.length > 100)) throw new Error("Invalid thread id");
        const clientId = body.clientMessageId;
        if (typeof clientId !== "string" || !clientId.trim() || clientId.length > 100) throw new Error("clientMessageId is required");
        const resolvedThreadId: string = typeof body.threadId === "string" ? body.threadId : randomUUID();
        threadId = resolvedThreadId;
        const thread = chats.createThread({ id: resolvedThreadId, title: message });
        const messageId = `${resolvedThreadId}:${clientId}`;
        const user = chats.append({ id: messageId, threadId: resolvedThreadId, role: "USER", content: message });
        const previous = chats.getMessageRun(messageId);
        if (previous?.status === "COMPLETED") return Response.json({ thread, reply: previous.output, runId: previous.id, ...chats.page(resolvedThreadId) });
        if (previous?.status === "RUNNING") return Response.json({ error: "Response is still generating", threadId, runId: previous.id }, { status: 409 });
        const messages = chats.getMessages(resolvedThreadId);
        const history = messages.slice(0, messages.findIndex((item) => item.id === user.id)).slice(-20).map((item) => `${item.role}: ${item.content.slice(0, 2000)}`).join("\n");
        const knowledge = await context(message);
        const values = { message, candidateContext: knowledge ? `<CANDIDATE_KNOWLEDGE>\n${knowledge}\n</CANDIDATE_KNOWLEDGE>\n\n` : "", history: history ? `<CONVERSATION_HISTORY>\n${history}\n</CONVERSATION_HISTORY>\n\n` : "" };
        const rendered = renderRuntimePrompt("CHAT", null, values, prompts);
        const prompt = rendered.prompt || `${values.candidateContext}${values.history}USER: ${message}\n\nRespond helpfully and concisely as the ASSISTANT.`;
        const claim = chats.claimRun(messageId, { promptKey: rendered.promptKey, purpose: "CHAT", systemInstruction: rendered.systemInstruction, prompt, context: { history, candidateContext: knowledge, promptCustomized: rendered.promptCustomized } });
        if (!claim.claimed) {
          if (claim.status !== "COMPLETED") return Response.json({ error: "Response is still generating", threadId, runId: claim.runId }, { status: 409 });
          return Response.json({ thread, reply: claim.output, runId: claim.runId, ...chats.page(resolvedThreadId) });
        }
        runId = claim.runId;
        const handle = await generate(prompt, { maxOutputTokens: 800, systemInstruction: rendered.systemInstruction, signal: request.signal });
        chats.configureRun(runId, handle.provider, handle.model);
        let lastCheckpoint = performance.now();
        let usage: unknown;
        for await (const chunk of handle.stream) {
          if (request.signal.aborted) throw new Error("Chat request interrupted");
          if (chunk.text) {
            output += chunk.text;
            if (performance.now() - lastCheckpoint > 500) { chats.progress(runId, output); lastCheckpoint = performance.now(); }
          }
          if (chunk.usage) usage = chunk.usage;
        }
        if (request.signal.aborted) throw new Error("Chat request interrupted");
        output = output.trim();
        if (!output) throw new Error("No response received");
        chats.complete(messageId, runId, output, { provider: handle.provider, model: handle.model, usage });
        return Response.json({ thread, reply: output, runId, ...chats.page(resolvedThreadId) });
      } catch (error) {
        const details = error instanceof Error ? error.message : "Chat request failed";
        if (runId) chats.finishRun(runId, { status: request.signal.aborted ? "INTERRUPTED" : "FAILED", output, error: details });
        return Response.json({ error: details, threadId, runId }, { status: runId ? 503 : 400 });
      }
    },
  };
}