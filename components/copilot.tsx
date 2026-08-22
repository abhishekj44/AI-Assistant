"use client";
import ReactMarkdown from "react-markdown";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import RecorderTranscriber from "@/components/recorder";
import { useCallback, useEffect, useRef, useState } from "react";

import { FLAGS, HistoryData } from "@/lib/types";
import { Switch } from "@/components/ui/switch";
import { PDFManager } from "@/components/PDFManager";
import { PDFModal } from "@/components/PDFModal";
import { PromptModal } from "@/components/PromptModal";
import { transcriptStateMachine, UtteranceSegment } from "@/lib/transcriptStateMachine";
import { ChatTranscription } from "@/components/ChatTranscription";
import { sessionManager } from "@/lib/sessionManager";
import { DEFAULT_PROMPT_RULES } from "@/lib/utils";

import {
  Sparkles,
  Bot,
  Eye,
  EyeOff,
  HelpCircle,
  BookOpen,
  FileText,
  Send,
  Zap,
  Globe,
  Save,
  Check,
  AlertCircle,
  Sliders,
} from "lucide-react";

interface CopilotProps {
  addInSavedData: (data: HistoryData) => void;
}

// Custom hook for Gemini stream completion
function useGeminiCompletion(body: any) {
  const [completion, setCompletion] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const [input, setInput] = useState<string>("");
  const [extractedQuestion, setExtractedQuestion] = useState<string>("");
  const [citations, setCitations] = useState<any[]>([]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim()) return;

      setIsLoading(true);
      setError(null);
      setCompletion("");
      setExtractedQuestion("");
      setCitations([]);

      try {
        const windowedPrompt = sessionManager.getSlidingWindowTranscript(input);
        const activeSummary = sessionManager.getSummary();

        // V2: Resolve complete focus question context by coalescing consecutive speaker turns
        const focusQuestion = transcriptStateMachine.getLatestQuestionContext(5, 10);

        // V2: Send structured turns with speaker labels instead of just raw text
        const recentFinalized = transcriptStateMachine.getRecentFinalizedTurns(15);
        const recentTurns = recentFinalized.map((u) => ({
          speaker: u.speaker,
          text: u.text,
          timestamp: u.timestamp,
        }));

        // Set the extracted question immediately from the full focus question
        if (focusQuestion) {
          setExtractedQuestion(focusQuestion);
        }

        const response = await fetch("/api/completion", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ...body,
            prompt: windowedPrompt,
            summary: activeSummary,
            focusQuestion,
            recentTurns,
          }),
        });

        if (!response.ok) {
          if (response.status === 503) {
            const errorData = await response.json();
            setCompletion("⚠️ AI service is temporarily unavailable. Please try again in a moment.");
            if (errorData.extractedQuestion) setExtractedQuestion(errorData.extractedQuestion);
            if (errorData.citations?.length) setCitations(errorData.citations);
            return;
          }
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        if (!reader) throw new Error("No response body");

        let rawText = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          rawText += chunk;

          if (rawText.includes("---SOURCES---")) {
            const [answerText, sourcesJson] = rawText.split("---SOURCES---");
            setCompletion(answerText.trim());

            if (sourcesJson && sourcesJson.trim()) {
              try {
                const parsed = JSON.parse(sourcesJson.trim());
                if (parsed.type === "citations") {
                  setCitations(parsed.citations || []);
                  if (parsed.extractedQuestion) {
                    setExtractedQuestion(parsed.extractedQuestion);
                  }
                }
              } catch (e) {
                // Incomplete JSON chunk, will parse on next stream event or end
              }
            }
          } else {
            setCompletion(rawText);
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err : new Error("Unknown error"));
      } finally {
        setIsLoading(false);
      }
    },
    [input, body]
  );

  const stop = useCallback(() => {
    setIsLoading(false);
  }, []);

  return {
    completion,
    isLoading,
    error,
    input,
    setInput,
    handleSubmit,
    stop,
    extractedQuestion,
    citations,
  };
}

export function Copilot({ addInSavedData }: CopilotProps) {
  const [transcribedText, setTranscribedText] = useState<string>("");
  const [flag, setFlag] = useState<FLAGS>(FLAGS.COPILOT);
  const [bg, setBg] = useState<string>("");
  const [customRules, setCustomRules] = useState<string>(DEFAULT_PROMPT_RULES);
  const [isPromptModalOpen, setIsPromptModalOpen] = useState<boolean>(false);
  const [chatMessages, setChatMessages] = useState<UtteranceSegment[]>([]);
  const [showChatView, setShowChatView] = useState<boolean>(true);
  const [stealthMode, setStealthMode] = useState<boolean>(false);
  const [isSaved, setIsSaved] = useState<boolean>(false);

  const [pdfModal, setPdfModal] = useState<{
    isOpen: boolean;
    filename: string;
    page?: number;
    citation?: any;
  }>({
    isOpen: false,
    filename: "",
    page: undefined,
    citation: undefined,
  });

  const { completion, isLoading, error, setInput, handleSubmit, extractedQuestion, citations } =
    useGeminiCompletion({
      bg,
      flag,
      customRules,
    });

  const handleFlag = useCallback((checked: boolean) => {
    setFlag(checked ? FLAGS.COPILOT : FLAGS.SUMMERIZER);
  }, []);

  const formRef = useRef<HTMLFormElement>(null);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.ctrlKey) {
      switch (event.key) {
        case "Enter":
          event.preventDefault();
          if (formRef.current) {
            formRef.current.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
          }
          break;
        case "s":
          event.preventDefault();
          setFlag(FLAGS.SUMMERIZER);
          break;
        case "c":
          event.preventDefault();
          setFlag(FLAGS.COPILOT);
          break;
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Subscribe directly to transcript state machine (Zero-polling)
  useEffect(() => {
    const unsubState = transcriptStateMachine.subscribe((messages) => {
      setChatMessages(messages);
    });

    const unsubUtterance = transcriptStateMachine.onUtteranceCompleted((utterance) => {
      // Formatted text with timestamp for prompt input
      const formatted = ` [${new Date(utterance.timestamp).toLocaleTimeString()}] ${utterance.text}\n`;
      setInput((prev) => prev + formatted);
      setTranscribedText((prev) => prev + formatted);

      // Record in session manager (survives UI clear)
      sessionManager.addTranscript(utterance.text, utterance.speaker);
    });

    return () => {
      unsubState();
      unsubUtterance();
    };
  }, [setInput]);

  const openPDFModal = (filename: string, page?: number, citation?: any) => {
    setPdfModal({ isOpen: true, filename, page, citation });
  };

  const closePDFModal = () => {
    setPdfModal({ isOpen: false, filename: "", page: undefined, citation: undefined });
  };

  const clearTranscriptionChange = () => {
    setInput("");
    setTranscribedText("");
    transcriptStateMachine.reset();
    setChatMessages([]);
  };

  useEffect(() => {
    const savedBg = localStorage.getItem("bg");
    if (savedBg) setBg(savedBg);
    const savedRules = localStorage.getItem("custom_prompt_rules");
    if (savedRules) setCustomRules(savedRules);
  }, []);

  useEffect(() => {
    if (!bg) return;
    localStorage.setItem("bg", bg);
  }, [bg]);

  const handleSaveBg = (newBg: string) => {
    setBg(newBg);
    localStorage.setItem("bg", newBg);
  };

  const handleSaveCustomRules = (newRules: string) => {
    setCustomRules(newRules);
    localStorage.setItem("custom_prompt_rules", newRules);
  };

  const handleSave = () => {
    addInSavedData({
      createdAt: new Date().toISOString(),
      data: completion,
      tag: flag === FLAGS.COPILOT ? "AI Mode" : "Summarizer",
    });
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2500);
  };

  // Keyboard shortcut: Ctrl+Shift+C to toggle stealth mode
  useEffect(() => {
    const handleStealthToggle = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === "KeyC") {
        setStealthMode((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleStealthToggle);
    return () => window.removeEventListener("keydown", handleStealthToggle);
  }, []);

  if (stealthMode) {
    return (
      <button
        className="fixed bottom-6 right-6 z-[9999] w-12 h-12 rounded-full bg-slate-950 text-white flex items-center justify-center shadow-2xl border border-slate-700 hover:scale-105 transition-all"
        title="Restore Assistant (Ctrl+Shift+C)"
        onClick={() => setStealthMode(false)}
      >
        <Eye className="w-5 h-5 text-indigo-400" />
      </button>
    );
  }

  return (
    <div className="w-full bg-slate-900 text-slate-100 font-sans selection:bg-indigo-500 selection:text-white">
      {/* Executive Top Navigation Header */}
      <header className="w-full bg-slate-950 border-b border-slate-800/80 px-6 py-3.5">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-base font-bold text-slate-100 tracking-tight flex items-center gap-2">
                AI Interview Copilot
                <span className="text-[10px] uppercase font-semibold tracking-wider px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                  Pro Engine
                </span>
              </h1>
              <p className="text-xs text-slate-400">Real-time interview telemetry & context assistant</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsPromptModalOpen(true)}
              className="h-8 px-3 text-xs text-slate-300 hover:text-white hover:bg-slate-800/80 border border-slate-800 rounded-lg flex items-center gap-1.5"
              title="Configure System Prompt Rules & Candidate Persona"
            >
              <Sliders className="w-3.5 h-3.5 text-indigo-400" />
              Prompt & Persona
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStealthMode(true)}
              className="h-8 px-3 text-xs text-slate-300 hover:text-white hover:bg-slate-800/80 border border-slate-800 rounded-lg"
              title="Stealth Mode (Ctrl+Shift+C)"
            >
              <EyeOff className="w-3.5 h-3.5 mr-1.5 text-indigo-400" />
              Stealth Mode
            </Button>
          </div>
        </div>
      </header>

      {/* Main Split Dashboard Layout */}
      <main className="max-w-7xl mx-auto px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          
          {/* Left Column: Live Audio Stream & Transcripts (5 Cols) */}
          <div className="lg:col-span-5 space-y-5">
            {/* Recorder Controls */}
            <RecorderTranscriber />

            {/* Live Transcription Box */}
            <div className="h-[440px]">
              <ChatTranscription messages={chatMessages} onClear={clearTranscriptionChange} className="h-full" />
            </div>

            {/* Knowledge Base & PDF RAG Manager */}
            <div className="bg-slate-950/60 rounded-xl p-4 border border-slate-800/80">
              <PDFManager />
            </div>
          </div>

          {/* Right Column: AI Output & Context Intelligence (7 Cols) */}
          <div className="lg:col-span-7 space-y-5">

            {/* Trigger Bar (Mode Switch + Process Button) */}
            <div className="bg-slate-950/70 rounded-xl p-4 border border-slate-800/80 shadow-md">
              <form ref={formRef} onSubmit={handleSubmit} className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 bg-slate-900/80 px-4 py-2 rounded-lg border border-slate-800">
                  <Label className="text-xs font-semibold text-slate-400">Summarizer</Label>
                  <Switch
                    className="data-[state=checked]:bg-indigo-600"
                    onCheckedChange={handleFlag}
                    checked={flag === FLAGS.COPILOT}
                  />
                  <Label className="text-xs font-semibold text-indigo-400 flex items-center gap-1">
                    <Sparkles className="w-3.5 h-3.5" /> AI Mode
                  </Label>
                </div>

                <Button
                  type="submit"
                  disabled={isLoading}
                  className="h-10 px-6 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-lg shadow-md shadow-indigo-600/20 transition-all flex items-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      <span>Thinking...</span>
                    </>
                  ) : (
                    <>
                      <span>Generate Answer</span>
                      <Send className="w-3.5 h-3.5" />
                    </>
                  )}
                </Button>
              </form>
            </div>

            {/* Question Detected Alert Banner */}
            {extractedQuestion && (
              <div className="bg-indigo-950/40 border border-indigo-500/30 rounded-xl p-4 shadow-sm animate-in fade-in duration-300">
                <div className="flex items-center gap-2 mb-1 text-xs font-semibold text-indigo-400">
                  <HelpCircle className="w-4 h-4 text-indigo-400" /> Question Identified
                </div>
                <p className="text-sm font-medium text-indigo-100 italic bg-indigo-950/60 p-3 rounded-lg border border-indigo-500/20">
                  &ldquo;{extractedQuestion}&rdquo;
                </p>
              </div>
            )}

            {/* AI Response Card */}
            {completion ? (
              <div className="bg-slate-950/70 rounded-xl border border-slate-800/80 shadow-md overflow-hidden animate-in fade-in duration-300">
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-slate-900/50">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-md bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 flex items-center justify-center">
                      <Zap className="w-3.5 h-3.5" />
                    </div>
                    <h3 className="text-sm font-semibold text-slate-100">Suggested Response</h3>
                  </div>

                  <Button
                    onClick={handleSave}
                    variant="ghost"
                    size="sm"
                    className="h-8 px-3 text-xs text-indigo-400 hover:text-indigo-300 hover:bg-indigo-950/40 font-medium"
                  >
                    {isSaved ? (
                      <>
                        <Check className="w-3.5 h-3.5 mr-1 text-emerald-400" /> Saved!
                      </>
                    ) : (
                      <>
                        <Save className="w-3.5 h-3.5 mr-1" /> Save
                      </>
                    )}
                  </Button>
                </div>

                <div className="p-5 text-sm text-slate-200 leading-relaxed font-sans prose prose-invert max-w-none">
                  <ReactMarkdown>{completion}</ReactMarkdown>
                </div>
              </div>
            ) : (
              !isLoading && (
                <div className="bg-slate-950/40 rounded-xl border border-slate-800/60 p-12 text-center text-slate-500">
                  <Bot className="w-10 h-10 mx-auto mb-3 opacity-30 text-indigo-400" />
                  <p className="text-sm font-medium text-slate-400">Ready for Question Stream</p>
                  <p className="text-xs text-slate-500 max-w-md mx-auto mt-1">
                    Connect audio to stream live questions, then press &quot;Generate Answer&quot; or press Ctrl+Enter.
                  </p>
                </div>
              )
            )}

            {/* Sources & Citations Section */}
            {citations && citations.length > 0 && (
              <div className="bg-slate-950/70 rounded-xl border border-slate-800/80 p-5 shadow-sm space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
                  <BookOpen className="w-4 h-4" /> RAG Knowledge Citations ({citations.length})
                </div>

                <div className="grid gap-2.5">
                  {citations.map((citation, index) => (
                    <div key={index} className="bg-slate-900/90 rounded-lg p-3 border border-slate-800 text-xs flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-200 flex items-center gap-1.5">
                          {citation.sourceType === "pdf" ? (
                            <FileText className="w-3.5 h-3.5 text-indigo-400" />
                          ) : (
                            <Globe className="w-3.5 h-3.5 text-emerald-400" />
                          )}
                          {citation.filename || citation.source}
                        </span>

                        {citation.sourceType === "pdf" && citation.page && (
                          <button
                            onClick={() => openPDFModal(citation.filename, citation.page, citation)}
                            className="text-[11px] px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 font-medium border border-indigo-500/20"
                          >
                            Page {citation.page}
                          </button>
                        )}
                      </div>

                      <p className="text-slate-400 text-[11px] line-clamp-2 italic bg-slate-950/50 p-2 rounded border border-slate-800/50">
                        &quot;{citation.contextSnippet || citation.content}&quot;
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Global Error Banner */}
            {error && (
              <div className="bg-rose-950/40 border border-rose-500/30 rounded-xl p-4 text-xs text-rose-300 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-400 flex-shrink-0" />
                <span>{error.message}</span>
              </div>
            )}

          </div>
        </div>
      </main>

      {/* PDF Modal Viewer */}
      <PDFModal
        isOpen={pdfModal.isOpen}
        onClose={closePDFModal}
        filename={pdfModal.filename}
        page={pdfModal.page}
        citation={pdfModal.citation}
      />

      {/* Prompt Configuration & Inspector Modal */}
      <PromptModal
        isOpen={isPromptModalOpen}
        onClose={() => setIsPromptModalOpen(false)}
        bg={bg}
        onSaveBg={handleSaveBg}
        customRules={customRules}
        onSaveCustomRules={handleSaveCustomRules}
        currentSummary={sessionManager.getSummary()}
        recentTurns={transcriptStateMachine.getRecentFinalizedTurns(15).map(u => ({ speaker: u.speaker, text: u.text }))}
        focusQuestion={extractedQuestion}
      />
    </div>
  );
}
