"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, MessageSquare, Trash2, User, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SpeakerRole } from "@/lib/conversationTypes";

interface ChatMessage {
  id: string;
  text: string;
  timestamp: string;
  speaker: SpeakerRole;
  isInterim?: boolean;
}

interface ChatTranscriptionProps {
  messages: ChatMessage[];
  onClear: () => void;
  className?: string;
}

export function ChatTranscription({ messages, onClear, className }: ChatTranscriptionProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const scrollToBottom = () => {
    const element = scrollContainerRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  useEffect(() => {
    if (autoScroll) scrollToBottom();
  }, [messages, autoScroll]);

  return (
    <div className={cn("flex flex-col h-full bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden", className)}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-center gap-2.5">
          <span className="relative flex h-2.5 w-2.5"><span className="animate-ping absolute h-full w-full rounded-full bg-emerald-400 opacity-75" /><span className="relative rounded-full h-2.5 w-2.5 bg-emerald-500" /></span>
          <h3 className="font-semibold text-slate-800 text-sm flex items-center gap-1.5"><MessageSquare className="w-4 h-4 text-indigo-600" /> Live Conversation</h3>
          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200/60 font-medium text-slate-600">{messages.length}</span>
        </div>
        {messages.length > 0 && (
          <Button onClick={onClear} variant="ghost" size="sm" className="h-7 px-2.5 text-xs text-rose-600 hover:bg-rose-50">
            <Trash2 className="w-3.5 h-3.5 mr-1" /> Clear UI
          </Button>
        )}
      </div>

      <div
        ref={scrollContainerRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          setAutoScroll(element.scrollHeight - element.scrollTop - element.clientHeight < 80);
        }}
        className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/30"
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-400 space-y-2 py-8">
            <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-500 flex items-center justify-center text-xl">🎙️</div>
            <p className="text-sm font-medium text-slate-600">Waiting for conversation audio…</p>
            <p className="text-xs text-slate-400 text-center">Connect system audio to start. Microphone capture is optional for your side of the conversation.</p>
          </div>
        ) : (
          messages.map((message) => {
            const interviewer = message.speaker === "interviewer";
            return (
              <div key={message.id} className={cn("flex flex-col", interviewer ? "items-start" : "items-end")}>
                <div className="flex items-center gap-1.5 mb-1 px-1">
                  <span className={cn("text-[11px] font-semibold flex items-center gap-1", interviewer ? "text-indigo-600" : "text-emerald-700")}>
                    {interviewer ? <User className="w-3 h-3" /> : <UserRound className="w-3 h-3" />}
                    {interviewer ? "Interviewer" : "Me"}
                  </span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                </div>
                <div className={cn(
                  "max-w-[90%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm",
                  interviewer ? "bg-white text-slate-800 border border-slate-200/80 rounded-tl-sm" : "bg-emerald-600 text-white rounded-tr-sm",
                  message.isInterim && "opacity-65 italic",
                )}>
                  {message.text}{message.isInterim && <span className="ml-1 opacity-60">…</span>}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="px-4 py-2 bg-slate-50 border-t border-slate-100 text-[11px] text-slate-500 flex items-center justify-between">
        <span>Speaker-aware turn context</span>
        {!autoScroll && <button onClick={() => { setAutoScroll(true); scrollToBottom(); }} className="text-indigo-600 font-medium flex items-center gap-0.5"><ArrowDown className="w-3 h-3" /> Latest</button>}
      </div>
    </div>
  );
}
