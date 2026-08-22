"use client";

import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { User, MessageSquare, Trash2, ArrowDown } from "lucide-react";

export interface ChatMessage {
  id: string;
  text: string;
  timestamp: string;
  speaker: "user" | "system" | "external";
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
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  };

  useEffect(() => {
    if (autoScroll) {
      scrollToBottom();
    }
  }, [messages, autoScroll]);

  const formatTime = (timestamp: string) => {
    try {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      return timestamp;
    }
  };

  return (
    <div className={cn("flex flex-col h-full bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden", className)}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-center gap-2.5">
          <div className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
          </div>
          <h3 className="font-semibold text-slate-800 text-sm tracking-tight flex items-center gap-1.5">
            <MessageSquare className="w-4 h-4 text-indigo-600" />
            Live Transcription
          </h3>
          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200/60 font-medium text-slate-600">
            {messages.length}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <Button
              onClick={onClear}
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 font-medium transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5 mr-1" />
              Clear UI
            </Button>
          )}
        </div>
      </div>

      {/* Messages Feed */}
      <div 
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto p-4 space-y-3 bg-slate-50/30"
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-400 space-y-2 py-8">
            <div className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-500 flex items-center justify-center text-xl shadow-inner">
              🎙️
            </div>
            <p className="text-sm font-medium text-slate-600">Waiting for live audio stream...</p>
            <p className="text-xs text-slate-400 max-w-xs text-center">
              Click &quot;Connect&quot; to start capturing interviewer audio.
            </p>
          </div>
        ) : (
          messages.map((message) => {
            const isInterviewer = message.speaker === "external" || message.speaker === "user";

            return (
              <div
                key={message.id}
                className={cn("flex flex-col group", isInterviewer ? "items-start" : "items-end")}
              >
                <div className="flex items-center gap-1.5 mb-1 px-1">
                  <span className="text-[11px] font-semibold text-indigo-600 flex items-center gap-1">
                    <User className="w-3 h-3" />
                    Interviewer
                  </span>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {formatTime(message.timestamp)}
                  </span>
                </div>

                <div
                  className={cn(
                    "max-w-[90%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-sm transition-all",
                    isInterviewer
                      ? "bg-white text-slate-800 border border-slate-200/80 rounded-tl-xs"
                      : "bg-indigo-600 text-white rounded-tr-xs",
                    message.isInterim && "opacity-75 italic bg-slate-100"
                  )}
                >
                  {message.text}
                  {message.isInterim && <span className="ml-1 text-slate-400">...</span>}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Footer Status Bar */}
      <div className="px-4 py-2 bg-slate-50 border-t border-slate-100 text-[11px] text-slate-500 flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
          Audio engine active
        </span>
        {!autoScroll && (
          <button
            onClick={() => {
              setAutoScroll(true);
              scrollToBottom();
            }}
            className="text-indigo-600 font-medium hover:underline flex items-center gap-0.5"
          >
            <ArrowDown className="w-3 h-3" /> Scroll to bottom
          </button>
        )}
      </div>
    </div>
  );
}
