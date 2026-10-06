"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, Send, X, RotateCcw, Trash2, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChatMessage {
  id: string;
  sender: "user" | "bot";
  text: string;
  timestamp: Date;
}

const THREAD_POINTER_KEY = "meetingCopilot.chatThreadId";
type StoredMessage = { id: string; role: "USER" | "ASSISTANT"; content: string; created_at: string };
function restoredMessages(rows: StoredMessage[]): ChatMessage[] {
  return rows.map((row) => ({ id: row.id, sender: row.role === "USER" ? "user" : "bot", text: row.content, timestamp: new Date(row.created_at) }));
}
function rememberThread(id: string) {
  try { localStorage.setItem(THREAD_POINTER_KEY, id); } catch {}
}

export function ChatbotPopup() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isBotTyping, setIsBotTyping] = useState(false);
  const [threadId, setThreadId] = useState("");
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; text: string } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const restore = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      let id = "";
      try { id = localStorage.getItem(THREAD_POINTER_KEY) || ""; } catch {}
      const response = await fetch(id ? `/api/chat?threadId=${encodeURIComponent(id)}` : "/api/chat", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok && response.status !== 404) throw new Error(data.error || "Unable to restore chat");
      if (!id && data.threads?.length) id = data.threads[0].id;
      let page = data;
      if (id && !data.messages && response.status !== 404) {
        const result = await fetch(`/api/chat?threadId=${encodeURIComponent(id)}`, { cache: "no-store" });
        page = await result.json();
        if (!result.ok) throw new Error(page.error || "Unable to restore chat");
      }
      if (response.status === 404) id = "";
      id ||= crypto.randomUUID();
      setThreadId(id);
      rememberThread(id);
      const rows: StoredMessage[] = page.messages || [];
      setMessages(restoredMessages(rows));
      setNextBefore(page.nextBefore || null);
      const last = rows.at(-1);
      setPending(last?.role === "USER" ? { id: last.id.slice(id.length + 1), text: last.content } : null);
      setReady(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to restore chat"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { if (isOpen && !ready) void restore(); }, [isOpen, ready, restore]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isBotTyping]);

  // Focus input when popup opens
  useEffect(() => {
    if (isOpen) {
      // Small delay so the animation finishes before focusing
      const timer = setTimeout(() => inputRef.current?.focus(), 150);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleSend = useCallback(async (retry = false) => {
    const attempt = retry ? pending : { id: crypto.randomUUID(), text: input.trim() };
    if (!attempt?.text || isBotTyping || !ready || loading) return;
    if (!retry) {
      setMessages((prev) => [...prev, { id: `${threadId}:${attempt.id}`, sender: "user", text: attempt.text, timestamp: new Date() }]);
      setInput("");
    }
    setPending(attempt);
    setError("");
    setIsBotTyping(true);
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ threadId, clientMessageId: attempt.id, message: attempt.text }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Chat request failed");
      setMessages((previous) => {
        const incoming = restoredMessages(data.messages || []);
        const ids = new Set(incoming.map((item) => item.id));
        return [...previous.filter((item) => !ids.has(item.id)), ...incoming];
      });
      setNextBefore(data.nextBefore || null);
      setPending(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Chat request failed");
    } finally {
      setIsBotTyping(false);
    }
  }, [input, isBotTyping, threadId, pending, ready, loading]);

  const loadOlder = async () => {
    if (!nextBefore || loading) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/chat?threadId=${encodeURIComponent(threadId)}&before=${encodeURIComponent(nextBefore)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load messages");
      setMessages((previous) => [...restoredMessages(data.messages), ...previous]);
      setNextBefore(data.nextBefore || null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load messages"); }
    finally { setLoading(false); }
  };

  const clearChat = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/chat?threadId=${encodeURIComponent(threadId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Unable to clear chat");
      const id = crypto.randomUUID();
      setThreadId(id);
      rememberThread(id);
      setMessages([]);
      setPending(null);
      setNextBefore(null);
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to clear chat"); }
    finally { setLoading(false); }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  return (
    <>
      {/* ─── Chat Window ─── */}
      <div
        className={cn(
          "fixed bottom-20 right-3 sm:right-6 z-[9998] flex flex-col overflow-hidden rounded-2xl border border-slate-700/80 bg-slate-950 shadow-2xl shadow-black/40 transition-all duration-200",
          isOpen
            ? "pointer-events-auto h-[min(480px,75dvh)] w-[min(380px,calc(100vw-24px))] scale-100 opacity-100"
            : "hidden",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 bg-gradient-to-r from-indigo-600/90 to-violet-600/90 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/15">
              <MessageCircle className="h-4 w-4 text-white" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">AI Assistant</h3>
              <p className="text-[10px] text-indigo-200">Ask me anything</p>
            </div>
          </div>
          <button type="button" title="Clear chat" aria-label="Clear chat" disabled={!ready || loading || isBotTyping} onClick={() => void clearChat()} className="ml-auto mr-2 text-white/70 hover:text-white disabled:opacity-40"><Trash2 className="h-4 w-4" /></button>
          <button
            onClick={() => setIsOpen(false)}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-white/70 transition-colors hover:bg-white/15 hover:text-white"
            aria-label="Close chat"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Messages area */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {loading && <p role="status" className="text-xs text-slate-400">Loading...</p>}
          {nextBefore && <button disabled={loading} onClick={() => void loadOlder()} className="flex items-center gap-1 text-xs text-slate-400"><ChevronUp className="h-3 w-3" /> Older messages</button>}
          {error && <div role="alert" className="text-xs text-rose-300">{error}</div>}
          {(!ready || pending) && !loading && !isBotTyping && <button onClick={() => void (ready ? handleSend(true) : restore())} className="flex items-center gap-1 text-xs text-slate-300"><RotateCcw className="h-3 w-3" /> {ready ? "Retry response" : "Retry loading"}</button>}
          {messages.length === 0 && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-500/10">
                <MessageCircle className="h-6 w-6 text-indigo-400 opacity-50" />
              </div>
              <p className="text-sm font-medium text-slate-400">Start a conversation</p>
              <p className="mt-1 text-xs text-slate-500">Type a message below to get started.</p>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                "flex",
                msg.sender === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words",
                  msg.sender === "user"
                    ? "rounded-br-md bg-indigo-600 text-white"
                    : "rounded-bl-md border border-slate-800 bg-slate-900 text-slate-200",
                )}
              >
                {msg.text}
                {Number.isFinite(msg.timestamp.getTime()) && <time dateTime={msg.timestamp.toISOString()} className="mt-1 block text-[10px] opacity-60">{msg.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}
              </div>
            </div>
          ))}

          {/* Typing indicator */}
          {isBotTyping && (
            <div className="flex justify-start">
              <div className="flex items-center gap-1 rounded-2xl rounded-bl-md border border-slate-800 bg-slate-900 px-4 py-3">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:0ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:300ms]" />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input bar */}
        <div className="border-t border-slate-800 bg-slate-900/80 px-3 py-2.5">
          <div className="flex items-center gap-2 rounded-xl border border-slate-700/80 bg-slate-950 px-3 py-1.5">
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message…"
              disabled={isBotTyping || !ready || loading || Boolean(pending)}
              maxLength={2000}
              className="min-w-0 flex-1 bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none disabled:opacity-50"
            />
            <button
              onClick={() => void handleSend()}
              disabled={!input.trim() || isBotTyping || !ready || loading || Boolean(pending)}
              className={cn(
                "flex h-8 w-8 flex-none items-center justify-center rounded-lg transition-all",
                input.trim() && !isBotTyping
                  ? "bg-indigo-600 text-white hover:bg-indigo-500"
                  : "text-slate-600",
              )}
              aria-label="Send message"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* ─── Floating Action Button ─── */}
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className={cn(
          "fixed bottom-6 right-6 z-[9999] flex h-14 w-14 items-center justify-center rounded-full shadow-lg shadow-indigo-500/25 transition-all duration-200 hover:scale-105 active:scale-95",
          isOpen
            ? "bg-slate-800 text-slate-300 hover:bg-slate-700"
            : "bg-gradient-to-tr from-indigo-600 to-violet-500 text-white hover:from-indigo-500 hover:to-violet-400",
        )}
        aria-label={isOpen ? "Close chat" : "Open chat"}
      >
        {isOpen ? (
          <X className="h-6 w-6" />
        ) : (
          <MessageCircle className="h-6 w-6" />
        )}
      </button>
    </>
  );
}
