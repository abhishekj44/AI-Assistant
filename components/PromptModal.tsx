"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { DEFAULT_PROMPT_RULES, buildPrompt, PROMPT_STYLE_STORAGE_KEY, PROMPT_RULES_VERSION, PROMPT_RULES_VERSION_STORAGE_KEY } from "@/lib/utils";
import type { SessionInfo, SpeakerRole } from "@/lib/conversationTypes";
import { CORE_QUALITY_RULES, getCallPromptTemplate, type CallPromptTemplate } from "@/lib/prompts";
import { hydrateSettings, getSetting, setSettings } from "@/lib/clientSettings";
import type { PromptRow, PromptPurpose } from "@/lib/server/repositories/promptRepository";
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
  GraduationCap,
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
  const [activeTab, setActiveTab] = useState<"rules" | "persona" | "preview" | "templates">("rules");
  const [localRules, setLocalRules] = useState<string>(customRules || DEFAULT_PROMPT_RULES);
  const [localBg, setLocalBg] = useState<string>(bg || "");
  const [isSaved, setIsSaved] = useState<boolean>(false);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [purpose, setPurpose] = useState<PromptPurpose>("ANSWER");
  const [profile, setProfile] = useState("INTERVIEWEE:standard");
  const [template, setTemplate] = useState<PromptRow | null>(null);
  const [callTemplate, setCallTemplate] = useState<PromptRow | null>(null);
  const [systemDraft, setSystemDraft] = useState("");
  const [userDraft, setUserDraft] = useState("");
  const [modeRules, setModeRules] = useState("");
  const [templateReload, setTemplateReload] = useState(0);

  const sessionProfile = `${sessionInfo?.callType === "taking_interview" ? "INTERVIEWER" : sessionInfo?.callType === "meeting" ? "MEETING" : "INTERVIEWEE"}:${sessionInfo?.callType === "taking_interview" && sessionInfo.modeVariant === "course_admission" ? "course_admission" : "standard"}`;

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setReady(false);
    setError("");
    setProfile(sessionProfile);
    void hydrateSettings().then(() => {
      if (!active) return;
      setLocalBg(getSetting("bg", bg || ""));
      setLocalRules(getSetting(PROMPT_STYLE_STORAGE_KEY, customRules || DEFAULT_PROMPT_RULES));
      setReady(true);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Settings unavailable"); });
    return () => { active = false; };
  }, [isOpen, sessionProfile]);

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    const [mode, variant] = sessionProfile.split(":");
    setCallTemplate(null);
    void fetch(`/api/prompts?purpose=ANSWER&mode=${mode}&variant=${variant}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load prompt");
      setCallTemplate(data.template);
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load prompt"); });
    return () => controller.abort();
  }, [isOpen, sessionProfile]);

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    const [mode, variant] = profile.split(":");
    const query = purpose === "CHAT" || purpose === "EXTRACTION" ? `purpose=${purpose}` : `purpose=${purpose}&mode=${mode}&variant=${variant}`;
    setTemplate(null);
    void fetch(`/api/prompts?${query}`, { cache: "no-store", signal: controller.signal }).then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load template");
      setTemplate(data.template);
      setSystemDraft(data.template.system_template);
      setUserDraft(data.template.user_template);
      setModeRules(data.template.parameters.modeRules || "");
    }).catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load template"); });
    return () => controller.abort();
  }, [isOpen, purpose, profile, templateReload]);

  useEffect(() => {
    setLocalRules(customRules || DEFAULT_PROMPT_RULES);
  }, [customRules]);

  useEffect(() => {
    setLocalBg(bg || "");
  }, [bg]);

  if (!isOpen) return null;

  const handleSave = async () => {
    setSaving(true);
    setError("");
    try {
      await setSettings({ bg: localBg, [PROMPT_STYLE_STORAGE_KEY]: localRules, [PROMPT_RULES_VERSION_STORAGE_KEY]: PROMPT_RULES_VERSION });
      onSaveCustomRules(localRules);
      onSaveBg(localBg);
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 2000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Settings save failed"); }
    finally { setSaving(false); }
  };

  const saveTemplate = async (reset = false) => {
    if (!template) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/prompts", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: template.template_key, baseVersion: template.version, purpose: template.purpose, mode: template.mode, variant: template.variant, system_template: systemDraft, user_template: userDraft, parameters: template.purpose === "ANSWER" ? { ...template.parameters, modeRules } : template.parameters, reset }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Template save failed");
      setTemplate(data.template);
      setSystemDraft(data.template.system_template);
      setUserDraft(data.template.user_template);
      setModeRules(data.template.parameters.modeRules || "");
      if (data.template.purpose === "ANSWER" && profile === sessionProfile) setCallTemplate(data.template);
      setIsSaved(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Template save failed"); }
    finally { setSaving(false); }
  };

  const handleResetDefaults = () => {
    setLocalRules(DEFAULT_PROMPT_RULES);
  };

  const sampleTurns: Array<{ speaker: SpeakerRole; text: string }> = recentTurns.length > 0
    ? recentTurns
    : [
        { speaker: "interviewer", text: "How would you handle scale in a distributed AI pipeline?" },
      ];

  const fallbackPreview = buildPrompt(
    localBg,
    "",
    currentSummary || "(No active summary yet)",
    sampleTurns,
    localRules,
    sessionInfo,
  );

  const promptProfile = callTemplate ? { ...getCallPromptTemplate(sessionInfo), ...callTemplate.parameters, assistantIdentity: callTemplate.system_template, finalOutputInstruction: callTemplate.user_template } as CallPromptTemplate : getCallPromptTemplate(sessionInfo);
  const interviewContext = sessionInfo?.callType === "taking_interview" ? `Candidate profile:\n${sessionInfo.candidateProfile || "(none)"}`
    : sessionInfo?.callType === "giving_interview" ? `Job description:\n${sessionInfo.jobDescription || "(none)"}` : "";
  const livePromptPreview = callTemplate ? `${promptProfile.assistantIdentity}\n\nCore quality rules:\n${CORE_QUALITY_RULES}\n\nMode rules (${promptProfile.displayName}):\n${promptProfile.modeRules}\n\nConfidence policy:\n${promptProfile.confidencePolicy}\n\nOptional style preferences:\n${localRules}\n\nPersonal/candidate notes:\n${sessionInfo?.callType === "taking_interview" ? "(not used in interviewer mode)" : localBg || "(none)"}\n\n${interviewContext}\n\nMemory:\n${currentSummary || "(none)"}\n\nRecent conversation:\n${sampleTurns.map((turn) => `${turn.speaker.toUpperCase()}: ${turn.text}`).join("\n")}\n\n${promptProfile.contextLabel}:\n<reconstructed remote context>\n\n${promptProfile.finalOutputInstruction}` : fallbackPreview;

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
          <button onClick={() => setActiveTab("templates")} className={`pb-3 px-3 text-xs font-semibold flex items-center gap-1.5 border-b-2 ${activeTab === "templates" ? "border-indigo-500 text-indigo-400" : "border-transparent text-slate-400"}`}><Code2 className="w-3.5 h-3.5" /> Templates</button>
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
          {error && <p role="alert" className="text-xs text-rose-400">{error}</p>}
          {activeTab === "templates" && <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <select aria-label="Prompt purpose" value={purpose} onChange={(event) => setPurpose(event.target.value as PromptPurpose)} disabled={saving} className="bg-slate-900 border border-slate-700 rounded px-2 py-1">{["ANSWER", "SUMMARY", "MEMORY", "EXTRACTION", "CHAT"].map((value) => <option key={value}>{value}</option>)}</select>
              {purpose !== "CHAT" && purpose !== "EXTRACTION" && <select aria-label="Prompt mode and variant" value={profile} onChange={(event) => setProfile(event.target.value)} disabled={saving} className="bg-slate-900 border border-slate-700 rounded px-2 py-1"><option value="INTERVIEWEE:standard">Giving Interview</option><option value="INTERVIEWER:standard">Taking Interview</option><option value="INTERVIEWER:course_admission">Course Admission</option><option value="MEETING:standard">Meeting</option></select>}
              {template && <span className="text-slate-400">Version {template.version} / {template.variant}</span>}
              <button type="button" title="Reload active template" aria-label="Reload active template" disabled={saving} onClick={() => { setError(""); setTemplateReload((version) => version + 1); }}><RotateCcw className="h-3.5 w-3.5" /></button>
            </div>
            {!template ? <p role="status">Loading template...</p> : <>
              <Label htmlFor="template-system">System Template</Label>
              <Textarea id="template-system" rows={7} value={systemDraft} disabled={saving} onChange={(event) => setSystemDraft(event.target.value)} className="bg-slate-900 border-slate-700 font-mono text-xs" />
              <Label htmlFor="template-user">User Template</Label>
              <Textarea id="template-user" rows={7} value={userDraft} disabled={saving} onChange={(event) => setUserDraft(event.target.value)} className="bg-slate-900 border-slate-700 font-mono text-xs" />
              {template.purpose === "ANSWER" && <><Label htmlFor="template-mode-rules">Mode Rules</Label><Textarea id="template-mode-rules" rows={5} value={modeRules} disabled={saving} onChange={(event) => setModeRules(event.target.value)} className="bg-slate-900 border-slate-700 font-mono text-xs" /></>}
              <div className="flex gap-2"><Button size="sm" disabled={saving} onClick={() => void saveTemplate()}><Save className="mr-1 h-3 w-3" /> Save Version</Button><Button size="sm" variant="ghost" disabled={saving} onClick={() => void saveTemplate(true)}><RotateCcw className="mr-1 h-3 w-3" /> Reset Template</Button></div>
            </>}
          </div>}
          
          {/* TAB 1: RULES */}
          {activeTab === "rules" && (
            <div className="space-y-3 animate-in fade-in duration-150">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                  Optional Style Preferences
                </Label>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setLocalRules(`- Tone: Extremely motivating, warm, and supportive. The candidate is being interviewed for course admission, not a job rejection.
- Encouragement: Actively praise sound instincts, curiosity, and practical problem-solving attempts.
- Normalizing errors: If an answer is inaccurate, frame it constructively and normalize it before asking a gentle, guided follow-up.
- Placement orientation: Focus follow-ups on understanding their learning trajectory and track fit (IIT Roorkee, IIT Kharagpur, IITM Pravartak, FDE Base, Pro).
- Scaffolded hints: When the candidate is hesitant or nervous, suggest a friendly hint or scaffolded prompt to help them think out loud.`);
                    }}
                    className="h-7 px-2 text-[11px] text-emerald-400 hover:text-emerald-300 hover:bg-emerald-950/40 border border-emerald-500/30"
                    title="Load supportive tone rules for course admission"
                  >
                    <GraduationCap className="w-3 h-3 mr-1" /> Course Mentoring Preset
                  </Button>
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
                {sessionInfo?.callType === "taking_interview" ? "Interviewer Notes & Candidate Context" : "Personal / Candidate Context"}
              </Label>
              <p className="text-[11px] text-slate-400">
                {sessionInfo?.callType === "taking_interview"
                  ? "In Taking Interview mode, use this to note details about the candidate (e.g. background, university, target track, or specific questions you want to ask). It is provided to the assistant as interviewer reference context."
                  : "Use this for optional personal background that is not already in the structured Knowledge Pack."}
              </p>
              <Textarea
                rows={9}
                value={localBg}
                onChange={(e) => setLocalBg(e.target.value)}
                placeholder={
                  sessionInfo?.callType === "taking_interview"
                    ? "e.g. Candidate: Rahul, 3rd year B.Tech CS, applied for IIT Kharagpur AI Engineering track. Ask about data pipelines and GenAI curiosity..."
                    : "e.g. Senior Software Engineer with 6+ years in Distributed Systems, Node.js, Next.js, agentic AI, and Azure..."
                }
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
              onClick={() => void handleSave()}
              disabled={!ready || saving || activeTab === "templates"}
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
