"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Briefcase, Building2, FileText, GraduationCap, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { CALL_TYPES, type CallType } from "@/lib/callTypes";
import type { SessionInfo } from "@/lib/conversationTypes";
import { getSetting, hydrateSettings, setSettings } from "@/lib/clientSettings";
import type { KnowledgeBase } from "@/lib/server/repositories/knowledgeBaseRepository";
import { prepareSessionInfo, sessionSetupError } from "@/lib/audio/capturePolicy";

const STORAGE_KEY_LAST_COMPANY = "meetingCopilot.lastCompany";

interface SessionInfoModalProps {
  open: boolean;
  onConfirm: (info: SessionInfo) => void;
  onCancel: () => void;
}

export function SessionInfoModal({ open, onConfirm, onCancel }: SessionInfoModalProps) {
  const [company, setCompany] = useState("");
  const [callType, setCallType] = useState<CallType | null>(null);
  const [details, setDetails] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [seniority, setSeniority] = useState("");
  const [candidateProfile, setCandidateProfile] = useState("");
  const [resumeSummary, setResumeSummary] = useState("No saved resume");
  const [basesError, setBasesError] = useState("");
  const [isCourseAdmission, setIsCourseAdmission] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [basesReady, setBasesReady] = useState(false);
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const companyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setJobTitle("");
    setJobDescription("");
    setSeniority("");
    setCandidateProfile("");
    setDetails("");
    setSaving(false);
    if (!open) return;
    let active = true;
    setCallType(null);
    setSettingsReady(false);
    setBasesReady(false);
    setKnowledgeBaseIds([]);
    setError("");
    setBasesError("");
    setResumeSummary("No saved resume");
    void hydrateSettings().then(() => {
      if (!active) return;
      setCompany(getSetting(STORAGE_KEY_LAST_COMPANY, ""));
      setIsCourseAdmission(getSetting<string>("meetingCopilot.modeVariant", "standard") === "course_admission");
      setSettingsReady(true);
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Settings unavailable"); });
    const timer = setTimeout(() => companyRef.current?.focus(), 80);
    return () => { active = false; clearTimeout(timer); };
  }, [open]);

  useEffect(() => {
    if (!open || (callType !== "meeting" && callType !== "giving_interview")) return;
    const controller = new AbortController();
    const meeting = callType === "meeting";
    if (meeting) { setBasesReady(false); setBasesError(""); }
    void fetch(meeting ? "/api/knowledge-bases" : "/api/knowledge", { cache: "no-store", signal: controller.signal }).then(async response => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Knowledge unavailable");
      if (controller.signal.aborted) return;
      if (meeting) {
        if (!Array.isArray(payload.bases)) throw new Error("Knowledge bases unavailable");
        setBases(payload.bases); setBasesReady(true);
      } else {
        const resume = Array.isArray(payload.sources) ? payload.sources.find((source: { type?: string; filename?: string }) => source.type === "resume") : undefined;
        const importedProfile = payload.profile?.headline || payload.profile?.summary;
        setResumeSummary(resume || importedProfile ? (importedProfile || resume.filename || "Saved resume") : "No saved resume");
      }
    }).catch(reason => {
      if (controller.signal.aborted) return;
      if (meeting) setBasesError(reason instanceof Error ? reason.message : "Knowledge bases unavailable");
      else setResumeSummary("No saved resume");
    });
    return () => controller.abort();
  }, [open, callType]);

  const handleCancel = useCallback(() => {
    setJobTitle(""); setJobDescription(""); setSeniority(""); setCandidateProfile(""); setDetails("");
    onCancel();
  }, [onCancel]);

  const handleConfirm = useCallback(async () => {
    if (!callType || !settingsReady || saving) return;
    const info = prepareSessionInfo({
      company: company.trim(),
      callType,
      details: details.trim(),
      jobTitle,
      jobDescription,
      seniority,
      candidateProfile,
      modeVariant: (callType === "taking_interview" && isCourseAdmission) ? "course_admission" : "standard",
      knowledgeBaseIds,
    });
    const validationError = sessionSetupError(info, basesReady);
    if (validationError) { setError(validationError); return; }
    setSaving(true);
    setError("");
    try { await setSettings({ [STORAGE_KEY_LAST_COMPANY]: info.company, "meetingCopilot.modeVariant": info.modeVariant }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Settings save failed"); setSaving(false); return; }
    onConfirm(info);
    setSaving(false);
    setCompany("");
    setCallType(null);
    setDetails("");
    setJobTitle("");
    setJobDescription("");
    setSeniority("");
    setCandidateProfile("");
    setIsCourseAdmission(false);
  }, [company, callType, details, jobTitle, jobDescription, seniority, candidateProfile, isCourseAdmission, onConfirm, settingsReady, basesReady, knowledgeBaseIds, saving]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && callType) {
      event.preventDefault();
      event.stopPropagation();
      handleConfirm();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      handleCancel();
    }
  }, [callType, handleConfirm, handleCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={handleCancel}>
      <div
        className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border border-slate-700/80 bg-slate-900 p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <button onClick={handleCancel} className="absolute right-4 top-4 rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Cancel">
          <X className="h-4 w-4" />
        </button>

        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500"><Briefcase className="h-5 w-5 text-white" /></div>
          <div>
            <h2 className="text-base font-bold text-white">Session Details</h2>
            <p className="text-xs text-slate-400">Choose the call mode first; V10 loads a different prompt profile for each mode.</p>
          </div>
        </div>

        <div className="space-y-4">
          {error && <p role="alert" className="text-xs text-rose-400">{error}</p>}
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-300"><Briefcase className="h-3.5 w-3.5 text-indigo-400" /> Call Type <span className="text-rose-400">*</span></div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {CALL_TYPES.map((type) => (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => { setCallType(type.value); setError(""); setJobTitle(""); setJobDescription(""); setSeniority(""); setCandidateProfile(""); setKnowledgeBaseIds(type.value === "taking_interview" ? [] : ["personal-knowledge"]); }}
                  className={`rounded-xl border p-3 text-left transition-all ${callType === type.value ? "border-indigo-500 bg-indigo-500/15 ring-1 ring-indigo-500/30" : "border-slate-700 bg-slate-800/50 hover:border-slate-600"}`}
                >
                  <div className={`text-xs font-semibold ${callType === type.value ? "text-indigo-300" : "text-slate-200"}`}>{type.label}</div>
                  <div className="mt-1 text-[10px] leading-relaxed text-slate-500">{type.value === "taking_interview" ? "You interview the remote candidate. Both speakers are required." : type.description}</div>
                </button>
              ))}
            </div>
          </div>

          {callType === "taking_interview" && (
            <div className="flex items-center gap-3 rounded-xl border border-indigo-500/30 bg-indigo-500/10 p-3.5 animate-in fade-in duration-200">
              <div className="w-8 h-8 rounded-lg bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-indigo-300 flex-none">
                <GraduationCap className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-indigo-200 flex items-center gap-1.5">
                  Course Selection / Admission Mode
                  <span className="text-[10px] font-medium px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">Temporary</span>
                </div>
                <div className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                  Motivate candidates during the interview, evaluate track fit (IIT Roorkee / Kharagpur / Pravartak / FDE), and reference the FDE interview questions guide.
                </div>
              </div>
              <Switch
                id="course-admission-toggle"
                checked={isCourseAdmission}
                onCheckedChange={setIsCourseAdmission}
                aria-label="Enable Course Admission Mode"
              />
            </div>
          )}

          {callType === "giving_interview" && <div><span className="mb-1.5 block text-xs font-semibold text-slate-300">Resume</span><p className="text-sm text-slate-300">{resumeSummary}</p></div>}

          {callType === "giving_interview" && <div>
            <label htmlFor="session-job-title" className="mb-1.5 block text-xs font-semibold text-slate-300">Job title</label>
            <input id="session-job-title" type="text" value={jobTitle} disabled={saving} onChange={event => setJobTitle(event.target.value)} placeholder="e.g. Backend Engineer" maxLength={200} className="w-full rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" />
          </div>}

          <div>
            <label htmlFor="session-company" className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-300"><Building2 className="h-3.5 w-3.5 text-indigo-400" /> {callType === "giving_interview" ? "Company (optional)" : "Company / Organization"}</label>
            <input ref={companyRef} id="session-company" type="text" value={company} disabled={!settingsReady || saving} onChange={(event) => setCompany(event.target.value)} placeholder="e.g. NVIDIA, NTT DATA" className="w-full rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" maxLength={200} />
          </div>

          {(callType === "giving_interview" || callType === "taking_interview") && (
            <div>
              <label htmlFor="session-interview-context" className="mb-1.5 block text-xs font-semibold text-slate-300">{callType === "giving_interview" ? "Job description" : "Candidate profile"} <span className="text-rose-400">*</span></label>
              <textarea id="session-interview-context" required maxLength={12000} rows={5} disabled={saving} value={callType === "giving_interview" ? jobDescription : candidateProfile} onChange={event => callType === "giving_interview" ? setJobDescription(event.target.value) : setCandidateProfile(event.target.value)} placeholder={callType === "giving_interview" ? "Paste the target role, responsibilities, required skills, and experience from the job description." : "Describe this candidate's factual role, experience, projects, and skills. Include only information supplied by the candidate."} aria-describedby="session-context-state" aria-invalid={!(callType === "giving_interview" ? jobDescription : candidateProfile).trim()} className="w-full rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" />
              <p id="session-context-state" className="mt-1 text-xs text-slate-400">{!(callType === "giving_interview" ? jobDescription : candidateProfile).trim() ? "Required for this session." : `${(callType === "giving_interview" ? jobDescription : candidateProfile).length} / 12000`}</p>
            </div>
          )}

          {callType === "giving_interview" && <div>
            <label htmlFor="session-seniority" className="mb-1.5 block text-xs font-semibold text-slate-300">Seniority</label>
            <select id="session-seniority" value={seniority} disabled={saving} onChange={event => setSeniority(event.target.value)} className="w-full rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500">
              <option value="">Not specified</option>
              {["Entry-level", "Junior", "Mid-level", "Senior", "Lead", "Staff", "Principal", "Manager", "Director", "Executive"].map(level => <option key={level} value={level}>{level}</option>)}
            </select>
          </div>}

          {callType === "taking_interview" && <div className="flex items-center gap-3"><Switch id="session-required-mic" checked disabled aria-label="Include my microphone" /><label htmlFor="session-required-mic" className="text-xs text-slate-300">Include my microphone <span className="block text-slate-400">Required for both speakers. Browser permission is requested after Start Session.</span></label></div>}

          {callType === "meeting" && <div>
            {basesError && <p role="alert" className="mb-1 text-xs text-rose-400">{basesError}</p>}
            <label htmlFor="session-knowledge-bases" className="mb-1.5 block text-xs font-semibold text-slate-300">Knowledge bases</label>
            <select id="session-knowledge-bases" multiple size={4} value={knowledgeBaseIds} disabled={!basesReady || saving || !callType} onChange={event => setKnowledgeBaseIds(Array.from(event.target.selectedOptions, option => option.value))} className="w-full rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs text-white">
              {bases.map(base => <option key={base.id} value={base.id}>{base.name} ({base.kind}){base.company ? ` · ${base.company}` : ""}</option>)}
            </select>
          </div>}

          <div>
            <label htmlFor="session-details" className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-300"><FileText className="h-3.5 w-3.5 text-indigo-400" /> {callType === "giving_interview" ? "Additional context" : "Details"}</label>
            <textarea id="session-details" value={details} disabled={saving} onChange={(event) => setDetails(event.target.value)} placeholder={callType === "giving_interview" ? "e.g. Second-round architecture interview, focus on reliability" : "e.g. Senior AI Engineer — Round 2 System Design, architecture review, weekly project sync"} rows={2} className="w-full resize-none rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" maxLength={1000} />
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <Button type="button" variant="ghost" size="sm" onClick={handleCancel} className="h-9 border border-slate-700 px-4 text-xs text-slate-400 hover:text-white">Cancel</Button>
          <Button type="button" size="sm" onClick={() => void handleConfirm()} disabled={!callType || !settingsReady || saving || Boolean(callType && sessionSetupError({ company, details, callType, jobTitle, jobDescription, seniority, candidateProfile, knowledgeBaseIds }, basesReady))} className="h-9 bg-emerald-600 px-5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"><Play className="mr-1.5 h-3.5 w-3.5" /> {saving ? "Saving..." : "Start Session"}</Button>
        </div>
        <p className="mt-3 text-center text-[10px] text-slate-500">Select a call type to continue · Ctrl+Enter to start · Esc to cancel</p>
      </div>
    </div>
  );
}
