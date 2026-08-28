"use client";

import { useEffect, useState } from "react";
import { FileJson, Loader2, MessageSquarePlus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

interface QAEntryView {
  id: string;
  category?: string;
  questions: string[];
  answer: string;
  keyPoints: string[];
  tags: string[];
  personal: boolean;
  priority: number;
  enabled: boolean;
  updatedAt: string;
}

interface QABankView {
  updatedAt: string;
  count: number;
  enabledCount: number;
  entries: QAEntryView[];
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function splitTags(value: string): string[] {
  return value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

export function QABankManager() {
  const [bank, setBank] = useState<QABankView | null>(null);
  const [questions, setQuestions] = useState("");
  const [answer, setAnswer] = useState("");
  const [category, setCategory] = useState("");
  const [keyPoints, setKeyPoints] = useState("");
  const [tags, setTags] = useState("");
  const [personal, setPersonal] = useState(false);
  const [priority, setPriority] = useState(5);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  const load = async () => {
    try {
      const response = await fetch("/api/qa-bank", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Unable to load Q&A bank");
      setBank(payload);
    } catch (error: any) {
      setStatus(error?.message || "Unable to load Q&A bank");
    }
  };

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("qa-bank-updated", refresh);
    return () => window.removeEventListener("qa-bank-updated", refresh);
  }, []);

  const resetForm = () => {
    setQuestions("");
    setAnswer("");
    setCategory("");
    setKeyPoints("");
    setTags("");
    setPersonal(false);
    setPriority(5);
  };

  const save = async () => {
    const variants = splitLines(questions);
    if (variants.length === 0 || !answer.trim()) {
      setStatus("Add at least one question variant and a prepared answer.");
      return;
    }

    setBusy(true);
    setStatus("Saving Q&A guidance…");
    try {
      const response = await fetch("/api/qa-bank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry: {
            questions: variants,
            answer: answer.trim(),
            category: category.trim() || undefined,
            keyPoints: splitLines(keyPoints),
            tags: splitTags(tags),
            personal,
            priority,
            enabled: true,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Unable to save Q&A entry");
      setBank(payload.bank);
      resetForm();
      setExpanded(false);
      setStatus("Q&A guidance saved. It will be matched locally on Generate Answer.");
    } catch (error: any) {
      setStatus(error?.message || "Unable to save Q&A entry");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (entryId: string) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/qa-bank?entryId=${encodeURIComponent(entryId)}`, { method: "DELETE" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Unable to delete Q&A entry");
      setBank(payload.bank);
      setStatus("Q&A entry removed.");
    } catch (error: any) {
      setStatus(error?.message || "Unable to delete Q&A entry");
    } finally {
      setBusy(false);
    }
  };

  const importJson = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setStatus(`Importing ${file.name}…`);
    try {
      if (file.size > 2_000_000) throw new Error("Q&A JSON file exceeds the 2 MB import limit");
      const parsed = JSON.parse(await file.text());
      const response = await fetch("/api/qa-bank", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bank: parsed, mode: "merge" }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Unable to import Q&A bank");
      setBank(payload.bank);
      setStatus(`${file.name} merged into the Q&A bank.`);
    } catch (error: any) {
      setStatus(error?.message || "Unable to import Q&A bank");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4 text-slate-200 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label className="text-xs font-semibold text-slate-100 flex items-center gap-1.5">
            <MessageSquarePlus className="w-4 h-4 text-violet-400" /> Prepared Q&A Guidance
          </Label>
          <p className="text-[11px] text-slate-500 mt-1">
            Optional answer guidance. Candidate Knowledge remains the factual source of truth.
          </p>
        </div>
        <span className="text-[10px] rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-1 text-violet-300">
          {bank?.enabledCount ?? 0} active
        </span>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => setExpanded((value) => !value)}
          className="h-9 flex-1 border border-violet-500/30 bg-violet-500/10 text-xs text-violet-300 hover:bg-violet-500/20"
        >
          <MessageSquarePlus className="w-3.5 h-3.5 mr-1.5" /> {expanded ? "Close form" : "Add Q&A"}
        </Button>
        <input id="qa-json-import" type="file" accept=".json,application/json" className="hidden" disabled={busy} onChange={importJson} />
        <label
          htmlFor="qa-json-import"
          className={`h-9 inline-flex items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${busy ? "cursor-not-allowed border-slate-800 text-slate-600" : "cursor-pointer border-slate-700 bg-slate-900 text-slate-300 hover:border-violet-500/40"}`}
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />} Import JSON
        </label>
      </div>

      {expanded && (
        <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-900/50 p-3">
          <div>
            <Label className="text-[10px] text-slate-400">Question variants · one per line</Label>
            <Textarea
              value={questions}
              onChange={(event) => setQuestions(event.target.value)}
              placeholder={"Why did you use RAG?\nWhy not fine-tune the model?"}
              className="mt-1 min-h-20 bg-slate-950 border-slate-700 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px] text-slate-400">Prepared answer</Label>
            <Textarea
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder="The factual answer you want the model to adapt, not repeat mechanically."
              className="mt-1 min-h-24 bg-slate-950 border-slate-700 text-xs"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <Label className="text-[10px] text-slate-400">Category</Label>
              <Input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="architecture" className="mt-1 h-8 bg-slate-950 border-slate-700 text-xs" />
            </div>
            <div>
              <Label className="text-[10px] text-slate-400">Tags · comma-separated</Label>
              <Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="rag, fine-tuning" className="mt-1 h-8 bg-slate-950 border-slate-700 text-xs" />
            </div>
          </div>
          <div>
            <Label className="text-[10px] text-slate-400">Key points · one per line</Label>
            <Textarea value={keyPoints} onChange={(event) => setKeyPoints(event.target.value)} placeholder={"grounding\ntraceability\nfrequent knowledge updates"} className="mt-1 min-h-16 bg-slate-950 border-slate-700 text-xs" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Switch checked={personal} onCheckedChange={setPersonal} />
              <span className="text-[10px] text-slate-400">Contains candidate-specific/personal claims</span>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-[10px] text-slate-400">Priority</Label>
              <select value={priority} onChange={(event) => setPriority(Number(event.target.value))} className="h-8 rounded border border-slate-700 bg-slate-950 px-2 text-xs">
                {[1, 3, 5, 7, 10].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <Button type="button" disabled={busy} onClick={() => void save()} className="h-8 bg-violet-600 hover:bg-violet-500 text-xs">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save Q&A"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {status && <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-[11px] text-slate-400">{status}</div>}

      {bank?.entries?.length ? (
        <div className="space-y-1.5 max-h-52 overflow-y-auto pr-1">
          {bank.entries.slice(0, 30).map((entry) => (
            <div key={entry.id} className="flex items-start justify-between gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-xs text-slate-200">
                  <FileJson className="w-3.5 h-3.5 text-violet-400 flex-none" />
                  <span className="truncate">{entry.questions[0]}</span>
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {entry.category || "general"} · {entry.questions.length} variant{entry.questions.length === 1 ? "" : "s"} · priority {entry.priority}
                </div>
              </div>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void remove(entry.id)} className="h-7 w-7 p-0 text-slate-500 hover:text-rose-400 hover:bg-rose-950/30">
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-[11px] text-slate-500">
          No prepared Q&A yet. Add a few high-value questions or import a compatible JSON bank.
        </div>
      )}
    </div>
  );
}
