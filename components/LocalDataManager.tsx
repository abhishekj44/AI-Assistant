"use client";

import { useEffect, useState } from "react";
import { Database, Download, FileText, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { callTypeLabel } from "@/lib/callTypes";
import type { SessionInfo, TranscriptTurn } from "@/lib/conversationTypes";

interface DatabaseStatus {
  healthy: boolean;
  counts: Record<string, number>;
  storage: { path: string; databaseBytes: number; walBytes: number; journalMode: string };
  legacyImport?: { sources: Array<{ sourceKey: string; status: string; error?: string }> };
}
interface StoredSession {
  id: string;
  startedAt: string;
  status: string;
  sessionInfo?: SessionInfo;
  summary?: string;
  summaryStatus: string;
  transcripts: TranscriptTurn[];
  throughSequence: number;
}

async function jsonRequest(url: string, options?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Local data request failed");
  return payload;
}

export function LocalDataManager() {
  const [database, setDatabase] = useState<DatabaseStatus | null>(null);
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [selected, setSelected] = useState<StoredSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [backupId, setBackupId] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void Promise.all([
      jsonRequest("/api/database", { signal: controller.signal }),
      jsonRequest("/api/sessions?limit=20", { signal: controller.signal }),
    ]).then(([status, history]) => {
      if (controller.signal.aborted) return;
      setDatabase(status);
      setSessions(history.sessions);
      setNextCursor(history.nextCursor);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to restore local data");
    });
    return () => controller.abort();
  }, [refresh]);

  const maintenance = async (action: "backup" | "rebuild") => {
    setBusy(true);
    setError("");
    try {
      const result = await jsonRequest("/api/database", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      if (action === "backup") setBackupId(result.id);
      setRefresh(value => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Database maintenance failed"); }
    finally { setBusy(false); }
  };

  const openSession = async (id: string) => {
    setBusy(true);
    setError("");
    try { setSelected((await jsonRequest(`/api/sessions?id=${encodeURIComponent(id)}`)).session); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load transcript"); }
    finally { setBusy(false); }
  };

  const moreSessions = async () => {
    if (!nextCursor) return;
    setBusy(true);
    try {
      const result = await jsonRequest(`/api/sessions?limit=20&cursor=${encodeURIComponent(nextCursor)}`);
      setSessions(previous => [...previous, ...result.sessions]);
      setNextCursor(result.nextCursor);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load sessions"); }
    finally { setBusy(false); }
  };

  return (
    <section className="min-w-0 border-t border-slate-800 py-4 text-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-semibold"><Database className="h-4 w-4 text-emerald-400" /> Local Data
          {database && <span className={`text-xs ${database.healthy ? "text-emerald-400" : "text-rose-400"}`}>{database.healthy ? "Healthy" : "Needs attention"}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRefresh(value => value + 1)} title="Refresh local data" aria-label="Refresh local data"><RefreshCw className="h-4 w-4" /></Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void maintenance("backup")}><Download className="mr-1.5 h-3.5 w-3.5" /> Create Backup</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void maintenance("rebuild")}><RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Rebuild Search Index</Button>
        </div>
      </div>
      {database && <div className="mt-2 break-all text-[11px] text-slate-500">{database.storage.path}<span className="ml-3">{((database.storage.databaseBytes + database.storage.walBytes) / 1048576).toFixed(1)} MB</span><span className="ml-3">{database.counts.transcript_turns} turns</span><span className="ml-3">{database.counts.knowledge_entries} knowledge entries</span></div>}
      {error && <p role="alert" className="mt-2 text-xs text-rose-400">{error}</p>}
      {database?.legacyImport?.sources.filter(source => source.status === "ERROR").map(source => <p role="alert" key={source.sourceKey} className="mt-2 text-xs text-amber-400">Import retained: {source.sourceKey}: {source.error}</p>)}
      {backupId && <a className="mt-3 inline-flex items-center gap-1.5 break-all text-xs text-emerald-400 underline" href={`/api/database?backup=${encodeURIComponent(backupId)}`} download><Download className="h-3.5 w-3.5 flex-none" /> {backupId}</a>}
      <div className="mt-5 flex items-center gap-2 text-xs font-semibold"><FileText className="h-4 w-4 text-indigo-400" /> Sessions</div>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-800 text-slate-500"><tr><th className="py-2 pr-3 font-medium">Started</th><th className="pr-3 font-medium">Company</th><th className="pr-3 font-medium">Mode</th><th className="pr-3 font-medium">Turns</th><th className="font-medium">Summary</th><th /></tr></thead>
          <tbody>{sessions.map(session => <tr key={session.id} className="border-b border-slate-800/50"><td className="whitespace-nowrap py-2 pr-3 text-slate-400">{new Date(session.startedAt).toLocaleString()}</td><td className="pr-3">{session.sessionInfo?.company || "-"}</td><td className="pr-3">{callTypeLabel(session.sessionInfo?.callType)}</td><td className="pr-3">{session.throughSequence}</td><td className="text-slate-500">{session.summaryStatus.toLowerCase()}</td><td className="text-right"><Button size="sm" variant="ghost" disabled={busy} onClick={() => void openSession(session.id)} title="Open session transcript" aria-label="Open session transcript"><FileText className="h-3.5 w-3.5" /></Button></td></tr>)}</tbody>
        </table>
      </div>
      {!sessions.length && <p className="mt-3 text-xs text-slate-500">No saved sessions.</p>}
      {nextCursor && <Button size="sm" variant="ghost" disabled={busy} className="mt-2" onClick={() => void moreSessions()}>More Sessions</Button>}
      {selected && <div className="mt-4 border-t border-slate-800 pt-3">
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{selected.sessionInfo?.company || "Session"}</h3><Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Close Transcript</Button></div>
        {selected.summary && <p className="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-slate-300">{selected.summary}</p>}
        <ol className="mt-4 max-h-80 space-y-3 overflow-y-auto pr-2">{selected.transcripts.map(turn => <li key={turn.id} className="border-l border-slate-700 pl-3"><span className="text-[10px] text-slate-500">{turn.speaker === "me" ? "Me" : selected.sessionInfo?.callType === "taking_interview" ? "Candidate" : "Remote"} · {new Date(turn.timestamp).toLocaleTimeString()}</span><p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">{turn.text}</p></li>)}</ol>
      </div>}
    </section>
  );
}