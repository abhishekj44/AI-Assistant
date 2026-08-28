"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, History, Loader2, Sparkles, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CallType } from "@/lib/callTypes";
import { callTypeLabel } from "@/lib/callTypes";

interface QAHistoryEntry {
  id: string;
  createdAt: string;
  question: string;
  answer: string;
  tag: string;
  feedback?: "good" | "poor";
  promotedAt?: string;
  callType: CallType;
}

export function QAHistoryManager() {
  const [entries, setEntries] = useState<QAHistoryEntry[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const load = async () => {
    try {
      const response = await fetch("/api/qa-history?limit=30", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Unable to load answer history");
      setEntries(Array.isArray(payload?.entries) ? payload.entries : []);
    } catch (error: any) {
      setStatus(error?.message || "Unable to load answer history");
    }
  };

  useEffect(() => { void load(); }, []);

  const rate = async (id: string, feedback: "good" | "poor") => {
    setBusyId(id);
    try {
      const response = await fetch("/api/qa-history", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, feedback }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Unable to save feedback");
      setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, feedback } : entry));
      const entry = entries.find((item) => item.id === id);
      setStatus(feedback === "good"
        ? entry?.callType === "giving_interview" ? "Answer marked Good. It can now be promoted to Prepared Q&A." : "Response marked Good. Promotion is only available for Giving Interview answers."
        : "Response marked Poor. It will remain history only.");
    } catch (error: any) {
      setStatus(error?.message || "Unable to save feedback");
    } finally {
      setBusyId(null);
    }
  };

  const promote = async (id: string) => {
    setBusyId(id);
    try {
      const response = await fetch("/api/qa-history", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Unable to promote answer");
      setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, promotedAt: new Date().toISOString() } : entry));
      window.dispatchEvent(new Event("qa-bank-updated"));
      setStatus(payload?.alreadyExists ? "A matching Prepared Q&A already exists." : "Approved answer promoted to Prepared Q&A.");
    } catch (error: any) {
      setStatus(error?.message || "Unable to promote answer");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-slate-200 space-y-3">
      <div>
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-100"><History className="h-4 w-4 text-cyan-400" /> Generated Answer Review</div>
        <p className="mt-1 text-[11px] text-slate-500">History never enters runtime Q&A automatically. Only answers you mark Good can be promoted.</p>
      </div>
      {status && <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-[11px] text-slate-400">{status}</div>}
      {entries.length === 0 ? (
        <div className="text-[11px] text-slate-500">No generated answers have been recorded yet.</div>
      ) : (
        <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
          {entries.map((entry) => (
            <div key={entry.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="text-xs font-medium text-slate-200 line-clamp-2">{entry.question || "Generated summary"}</div>
                <span className="shrink-0 rounded-full border border-slate-700 bg-slate-950 px-2 py-0.5 text-[9px] text-slate-500">{callTypeLabel(entry.callType)}</span>
              </div>
              <div className="mt-1 line-clamp-2 text-[11px] text-slate-500">{entry.answer}</div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Button type="button" variant="ghost" size="sm" disabled={busyId === entry.id || Boolean(entry.promotedAt)} onClick={() => void rate(entry.id, "good")} className={`h-7 px-2 text-[10px] ${entry.feedback === "good" ? "bg-emerald-500/10 text-emerald-300" : "text-slate-500"}`}><ThumbsUp className="mr-1 h-3 w-3" /> Good</Button>
                <Button type="button" variant="ghost" size="sm" disabled={busyId === entry.id || Boolean(entry.promotedAt)} onClick={() => void rate(entry.id, "poor")} className={`h-7 px-2 text-[10px] ${entry.feedback === "poor" ? "bg-rose-500/10 text-rose-300" : "text-slate-500"}`}><ThumbsDown className="mr-1 h-3 w-3" /> Poor</Button>
                {entry.callType === "giving_interview" && <Button type="button" variant="ghost" size="sm" disabled={busyId === entry.id || entry.feedback !== "good" || Boolean(entry.promotedAt) || !entry.question} onClick={() => void promote(entry.id)} className="h-7 px-2 text-[10px] text-violet-300 disabled:text-slate-700">
                  {busyId === entry.id ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : entry.promotedAt ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <Sparkles className="mr-1 h-3 w-3" />}{entry.promotedAt ? "Promoted" : "Promote to Q&A"}
                </Button>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
