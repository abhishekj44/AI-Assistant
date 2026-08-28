"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { DEFAULT_PROMPT_RULES, buildPrompt } from "@/lib/utils";
import type { SessionInfo, SpeakerRole } from "@/lib/conversationTypes";
import { getCallPromptTemplate } from "@/lib/prompts";
import {
  Sliders,
  Sparkles,
  User,
  Eye,
  Save,
  RotateCcw,
  X,
  Check,
  Code2,
  FileText,
  HelpCircle,
} from "lucide-react";

interface PromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  bg: string;
  onSaveBg: (newBg: string) => void;
  customRules: string;
  onSaveCustomRules: (newRules: string) => void;
  currentSummary?: string;
  recentTurns?: Array<{ speaker: SpeakerRole; text: string }>;
  focusQuestion?: string;
  sessionInfo?: SessionInfo;
}

export function PromptModal({
  isOpen,
  onClose,
  bg,
  onSaveBg,
  customRules,
  onSaveCustomRules,
  currentSummary = "",
  recentTurns = [],
  focusQuestion = "",
  sessionInfo,
}: PromptModalProps) {
  const [activeTab, setActiveTab] = useState<"rules" | "persona" | "preview">("rules");
  const [localRules, setLocalRules] = useState<string>(customRules || DEFAULT_PROMPT_RULES);
  const [localBg, setLocalBg] = useState<string>(bg || "");
  const [isSaved, setIsSaved] = useState<boolean>(false);

  useEffect(() => {
    setLocalRules(customRules || DEFAULT_PROMPT_RULES);
  }, [customRules]);

  useEffect(() => {
    setLocalBg(bg || "");
  }, [bg]);

  if (!isOpen) return null;

  const handleSave = () => {
    onSaveCustomRules(localRules);
    onSaveBg(localBg);
    setIsSaved(true);
    setTimeout(() => setIsSaved(false), 2000);
  };

  const handleResetDefaults = () => {
    setLocalRules(DEFAULT_PROMPT_RULES);
  };

  // Generate real-time preview of the actual prompt
  const sampleTurns: Array<{ speaker: SpeakerRole; text: string }> = recentTurns.length > 0
    ? recentTurns
    : [
        { speaker: "interviewer", text: "How would you handle scale in a distributed AI pipeline?" },
      ];

  const livePromptPreview = buildPrompt(
    localBg,
    "",
    currentSummary || "(No active summary yet)",
    sampleTurns,
    localRules,
    sessionInfo,
  );

  const promptProfile = getCallPromptTemplate(sessionInfo);

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
      <div className="bg-slate-950 border border-slate-800 rounded-2xl max-w-3xl w-full max-h-[88vh] flex flex-col shadow-2xl overflow-hidden">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <Sliders className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                Prompt & System Configuration
                <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                  Settings
                </span>
              </h2>
              <p className="text-xs text-slate-400">Prompt profile: {promptProfile.displayName} · customize style/persona and inspect the layout</p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center transition-all"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Selector */}
        <div className="flex items-center gap-2 px-6 pt-3 border-b border-slate-800/80 bg-slate-900/30">
          <button
            onClick={() => setActiveTab("rules")}
            className={`pb-3 px-3 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition-all ${
              activeTab === "rules"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            Style Preferences
          </button>

          <button
            onClick={() => setActiveTab("persona")}
            className={`pb-3 px-3 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition-all ${
              activeTab === "persona"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <User className="w-3.5 h-3.5" />
            Personal Context & Background
          </button>

          <button
            onClick={() => setActiveTab("preview")}
            className={`pb-3 px-3 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition-all ${
              activeTab === "preview"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            <Eye className="w-3.5 h-3.5" />
            Live Prompt Inspector
          </button>
        </div>

        {/* Modal Body Content */}
        <div className="p-6 overflow-y-auto flex-1 space-y-4 text-xs font-sans">
          
          {/* TAB 1: RULES */}
          {activeTab === "rules" && (
            <div className="space-y-3 animate-in fade-in duration-150">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                  Optional Style Preferences
                </Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleResetDefaults}
                  className="h-7 px-2 text-[11px] text-slate-400 hover:text-indigo-300 hover:bg-slate-900 border border-slate-800"
                >
                  <RotateCcw className="w-3 h-3 mr-1" /> Reset Defaults
                </Button>
              </div>
              <p className="text-[11px] text-slate-400">
                V10 core quality rules and the selected call-type prompt are versioned and always applied. These preferences only adjust tone/format and cannot replace the core answer contract.
              </p>
              <Textarea
                rows={9}
                value={localRules}
                onChange={(e) => setLocalRules(e.target.value)}
                placeholder="Optional tone/format preferences (one per line)..."
                className="w-full bg-slate-900/90 border border-slate-800 rounded-xl p-3 text-slate-200 font-mono text-xs leading-relaxed focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          )}

          {/* TAB 2: PERSONA / BACKGROUND */}
          {activeTab === "persona" && (
            <div className="space-y-3 animate-in fade-in duration-150">
              <Label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-indigo-400" />
                Personal / Candidate Context
              </Label>
              <p className="text-[11px] text-slate-400">
                Use this for optional personal background that is not already in the structured Knowledge Pack. It is ignored in Taking Interview mode so interviewer follow-ups are not biased by your own candidate profile.
              </p>
              <Textarea
                rows={9}
                value={localBg}
                onChange={(e) => setLocalBg(e.target.value)}
                placeholder="e.g. Senior Software Engineer with 6+ years in Distributed Systems, Node.js, Next.js, agentic AI, and Azure..."
                className="w-full bg-slate-900/90 border border-slate-800 rounded-xl p-3 text-slate-200 font-mono text-xs leading-relaxed focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
            </div>
          )}

          {/* TAB 3: LIVE PROMPT INSPECTOR */}
          {activeTab === "preview" && (
            <div className="space-y-3 animate-in fade-in duration-150">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                  <Code2 className="w-3.5 h-3.5" />
                  Representative Prompt Layout
                </Label>
                <span className="text-[10px] text-slate-500">Live Preview</span>
              </div>
              <p className="text-[11px] text-slate-400">
                This shows a representative prompt layout incorporating your custom rules, persona notes, meeting memory, and recent turns.
              </p>
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 font-mono text-[11px] text-slate-300 whitespace-pre-wrap leading-relaxed max-h-[300px] overflow-y-auto">
                {livePromptPreview}
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-6 py-3.5 border-t border-slate-800 bg-slate-900/60">
          <div className="text-[11px] text-slate-400 flex items-center gap-1.5">
            <HelpCircle className="w-3.5 h-3.5 text-indigo-400" />
            Saved settings persist across browser sessions.
          </div>

          <div className="flex items-center gap-2.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-8 px-4 text-xs text-slate-400 hover:text-white"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSave}
              className="h-8 px-5 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs rounded-lg shadow-md shadow-indigo-600/20 transition-all flex items-center gap-1.5"
            >
              {isSaved ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-300" />
                  <span>Saved!</span>
                </>
              ) : (
                <>
                  <Save className="w-3.5 h-3.5" />
                  <span>Save Changes</span>
                </>
              )}
            </Button>
          </div>
        </div>

      </div>
    </div>
  );
}
