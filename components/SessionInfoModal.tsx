"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Briefcase, Building2, FileText, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CALL_TYPES, type CallType } from "@/lib/callTypes";
import type { SessionInfo } from "@/lib/conversationTypes";

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
  const companyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setCallType(null); // Require an explicit mode choice for every new call.
    try {
      const last = localStorage.getItem(STORAGE_KEY_LAST_COMPANY);
      if (last) setCompany(last);
    } catch { /* non-fatal */ }
    setTimeout(() => companyRef.current?.focus(), 80);
  }, [open]);

  const handleConfirm = useCallback(() => {
    if (!callType) return;
    const info: SessionInfo = {
      company: company.trim(),
      callType,
      details: details.trim(),
    };
    try {
      if (info.company) localStorage.setItem(STORAGE_KEY_LAST_COMPANY, info.company);
    } catch { /* non-fatal */ }
    onConfirm(info);
    setCompany("");
    setCallType(null);
    setDetails("");
  }, [company, callType, details, onConfirm]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && callType) {
      event.preventDefault();
      handleConfirm();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }, [callType, handleConfirm, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onCancel}>
      <div
        className="relative w-full max-w-lg rounded-2xl border border-slate-700/80 bg-slate-900 p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <button onClick={onCancel} className="absolute right-4 top-4 rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Cancel">
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
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-300"><Briefcase className="h-3.5 w-3.5 text-indigo-400" /> Call Type <span className="text-rose-400">*</span></div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {CALL_TYPES.map((type) => (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => setCallType(type.value)}
                  className={`rounded-xl border p-3 text-left transition-all ${callType === type.value ? "border-indigo-500 bg-indigo-500/15 ring-1 ring-indigo-500/30" : "border-slate-700 bg-slate-800/50 hover:border-slate-600"}`}
                >
                  <div className={`text-xs font-semibold ${callType === type.value ? "text-indigo-300" : "text-slate-200"}`}>{type.label}</div>
                  <div className="mt-1 text-[10px] leading-relaxed text-slate-500">{type.description}</div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="session-company" className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-300"><Building2 className="h-3.5 w-3.5 text-indigo-400" /> Company / Organization</label>
            <input ref={companyRef} id="session-company" type="text" value={company} onChange={(event) => setCompany(event.target.value)} placeholder="e.g. NVIDIA, NTT DATA" className="w-full rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" maxLength={200} />
          </div>

          <div>
            <label htmlFor="session-details" className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-300"><FileText className="h-3.5 w-3.5 text-indigo-400" /> Details</label>
            <textarea id="session-details" value={details} onChange={(event) => setDetails(event.target.value)} placeholder="e.g. Senior AI Engineer — Round 2 System Design, architecture review, weekly project sync" rows={2} className="w-full resize-none rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-sm text-white placeholder-slate-500 outline-none focus:border-indigo-500" maxLength={1000} />
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} className="h-9 border border-slate-700 px-4 text-xs text-slate-400 hover:text-white">Cancel</Button>
          <Button type="button" size="sm" onClick={handleConfirm} disabled={!callType} className="h-9 bg-emerald-600 px-5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"><Play className="mr-1.5 h-3.5 w-3.5" /> Start Session</Button>
        </div>
        <p className="mt-3 text-center text-[10px] text-slate-500">Select a call type to continue · Ctrl+Enter to start · Esc to cancel</p>
      </div>
    </div>
  );
}
