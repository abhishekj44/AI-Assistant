"use client";

import { useEffect, useState } from "react";
import { BookOpen, FileJson, FileText, Loader2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { KnowledgeDocumentType } from "@/lib/knowledge/types";

interface KnowledgePackView {
  updatedAt: string;
  profile?: { headline?: string; summary?: string; strengths?: string[] };
  targetRole?: { title?: string; company?: string };
  stats: { sources: number; experience: number; projects: number; skills: number; facts: number };
  keyterms?: string[];
  sources: Array<{ id: string; filename: string; type: KnowledgeDocumentType; summary: string; uploadedAt: string }>;
}

const TYPES: Array<{ value: KnowledgeDocumentType; label: string }> = [
  { value: "resume", label: "Resume / CV" },
  { value: "job_description", label: "Job description" },
  { value: "project", label: "Project document" },
  { value: "notes", label: "Candidate notes" },
  { value: "other", label: "Other" },
];

export function KnowledgePackManager() {
  const [pack, setPack] = useState<KnowledgePackView | null>(null);
  const [documentType, setDocumentType] = useState<KnowledgeDocumentType>("resume");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");

  const load = async () => {
    try {
      const response = await fetch("/api/knowledge", { cache: "no-store" });
      if (response.ok) setPack(await response.json());
    } catch {
      setStatus("Could not load the Candidate Knowledge Pack.");
    }
  };

  useEffect(() => { void load(); }, []);

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setStatus("Extracting factual candidate knowledge…");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("documentType", documentType);
      const response = await fetch("/api/knowledge", { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Knowledge upload failed");
      setPack(payload.pack);
      setStatus(`${file.name} added to the Candidate Knowledge Pack.`);
    } catch (error: any) {
      setStatus(error?.message || "Knowledge upload failed");
    } finally {
      setBusy(false);
    }
  };


  const importPack = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setStatus("Knowledge Pack JSON must be 2 MB or smaller.");
      return;
    }
    setBusy(true);
    setStatus("Importing refined Candidate Knowledge Pack…");
    try {
      const parsed = JSON.parse(await file.text());
      const response = await fetch("/api/knowledge", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pack: parsed }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Knowledge Pack import failed");
      setPack(payload.pack);
      setStatus(`${file.name} imported as the active Candidate Knowledge Pack.`);
    } catch (error: any) {
      setStatus(error?.message || "Knowledge Pack import failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (sourceId: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/knowledge?sourceId=${encodeURIComponent(sourceId)}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Delete failed");
      setPack(payload.pack);
      setStatus("Knowledge source removed and pack rebuilt.");
    } catch (error: any) {
      setStatus(error?.message || "Delete failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-slate-200 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label className="text-xs font-semibold text-slate-100 flex items-center gap-1.5"><BookOpen className="w-4 h-4 text-indigo-400" /> Candidate Knowledge Pack</Label>
          <p className="text-[11px] text-slate-500 mt-1">Add factual source material or import a refined pack; no vector search is required during Generate Answer.</p>
        </div>
        {pack?.stats && <span className="text-[10px] rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2 py-1 text-indigo-300">{pack.stats.sources} sources · {pack.stats.projects} projects</span>}
      </div>

      <div className="flex gap-2">
        <select
          value={documentType}
          disabled={busy}
          onChange={(event) => setDocumentType(event.target.value as KnowledgeDocumentType)}
          className="h-9 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-2.5 text-xs text-slate-200 outline-none focus:border-indigo-500"
        >
          {TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
        </select>
        <input id="knowledge-upload" type="file" accept=".pdf,.txt,.md,.json" className="hidden" disabled={busy} onChange={upload} />
        <label htmlFor="knowledge-upload" className={`h-9 inline-flex items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${busy ? "cursor-not-allowed border-slate-800 text-slate-600" : "cursor-pointer border-indigo-500/30 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20"}`}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Add source
        </label>
        <input id="knowledge-pack-import" type="file" accept=".json,application/json" className="hidden" disabled={busy} onChange={importPack} />
        <label htmlFor="knowledge-pack-import" title="Import a complete refined Candidate Knowledge Pack JSON" className={`h-9 inline-flex items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${busy ? "cursor-not-allowed border-slate-800 text-slate-600" : "cursor-pointer border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"}`}>
          <FileJson className="w-3.5 h-3.5" /> Import pack
        </label>
      </div>

      {status && <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-[11px] text-slate-400">{status}</div>}

      {pack?.profile?.headline && <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3"><div className="text-[10px] uppercase tracking-wider text-slate-500">Candidate snapshot</div><div className="text-xs font-medium text-slate-200 mt-1">{pack.profile.headline}</div>{pack.targetRole?.title && <div className="text-[11px] text-indigo-300 mt-1">Target: {pack.targetRole.title}{pack.targetRole.company ? ` · ${pack.targetRole.company}` : ""}</div>}</div>}

      {pack?.sources?.length ? (
        <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
          {pack.sources.map((source) => (
            <div key={source.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs text-slate-200"><FileText className="w-3.5 h-3.5 text-indigo-400 flex-none" /><span className="truncate">{source.filename}</span></div>
                <div className="text-[10px] text-slate-500 mt-0.5">{TYPES.find((type) => type.value === source.type)?.label || source.type}</div>
              </div>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove(source.id)} className="h-7 w-7 p-0 text-slate-500 hover:text-rose-400 hover:bg-rose-950/30"><Trash2 className="w-3.5 h-3.5" /></Button>
            </div>
          ))}
        </div>
      ) : <div className="text-[11px] text-slate-500">No documents yet. Start with your resume, then add the target JD and important project notes.</div>}
    </div>
  );
}
