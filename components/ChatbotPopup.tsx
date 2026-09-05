"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, Send, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChatMessage {
  id: string;
  sender: "user" | "bot";
  text: string;
  timestamp: Date;
}

/**
 * Sends the user's message (with conversation history) to the chat API
 * and returns the bot's reply.
 */
async function sendMessageToAPI(
  messageText: string,
  history: ChatMessage[],
): Promise<string> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: messageText,
      history: history.map((msg) => ({ sender: msg.sender, text: msg.text })),
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.details || data?.error || "Chat request failed");
  return data.reply || "No response received.";
}

export function ChatbotPopup() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isBotTyping, setIsBotTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isBotTyping) return;

    const userMessage: ChatMessage = {
      id: `msg_${Date.now()}_user`,
      sender: "user",
      text: trimmed,
      timestamp: new Date(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsBotTyping(true);

    try {
      const reply = await sendMessageToAPI(trimmed, messages);
      const botMessage: ChatMessage = {
        id: `msg_${Date.now()}_bot`,
        sender: "bot",
        text: reply,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, botMessage]);
    } catch {
      const errorMessage: ChatMessage = {
        id: `msg_${Date.now()}_err`,
        sender: "bot",
        text: "Sorry, something went wrong. Please try again.",
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setIsBotTyping(false);
    }
  }, [input, isBotTyping]);

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
          "fixed bottom-20 right-6 z-[9998] flex flex-col overflow-hidden rounded-2xl border border-slate-700/80 bg-slate-950 shadow-2xl shadow-black/40 transition-all duration-200",
          isOpen
            ? "pointer-events-auto h-[480px] w-[380px] scale-100 opacity-100"
            : "pointer-events-none h-0 w-0 scale-90 opacity-0",
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
              disabled={isBotTyping}
              className="flex-1 bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none disabled:opacity-50"
            />
            <button
              onClick={() => void handleSend()}
              disabled={!input.trim() || isBotTyping}
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
