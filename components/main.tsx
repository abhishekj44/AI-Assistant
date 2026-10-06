"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { ChevronDown, History as HistoryIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Copilot } from "@/components/copilot";
import { mapSavedHistory, migrateSavedHistory, type ClientHistoryEntry, type HistoryData } from "@/lib/types";

const History = dynamic(() => import("@/components/History"), { ssr: false });
const ChatbotPopup = dynamic(
  () => import("@/components/ChatbotPopup").then((m) => m.ChatbotPopup),
  { ssr: false },
);

export default function MainPage() {
  const [savedData, setSavedData] = useState<HistoryData[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyError, setHistoryError] = useState("");

  const addInSavedData = (data: HistoryData) => {
    if (!data.id) return;
    setSavedData((prevData) => [data, ...prevData.filter((entry) => entry.id !== data.id)].slice(0, 100));
  };

  const deleteData = async (id: string) => {
    try {
      const response = await fetch("/api/qa-history", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, saved: false }) });
      if (!response.ok) throw new Error("Unable to remove saved response");
      setSavedData((prevData) => prevData.filter((data) => data.id !== id));
      setHistoryError("");
    } catch (error) { setHistoryError(error instanceof Error ? error.message : "Unable to remove saved response"); }
  };

  useEffect(() => {
    const controller = new AbortController();
    const restore = async () => {
      try {
        await migrateSavedHistory(localStorage, async (entry) => {
          const response = await fetch("/api/qa-history", {
            method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
            body: JSON.stringify({ ...entry, answer: entry.data }),
          });
          const payload = await response.json();
          if (!response.ok || (payload.id || payload.entry?.id) !== entry.id) throw new Error(payload.error || "Browser history import was not acknowledged");
        });
      } catch (error) {
        if (!controller.signal.aborted) setHistoryError(error instanceof Error ? error.message : "Unable to migrate browser history");
      }
      if (controller.signal.aborted) return;
      try {
        const response = await fetch("/api/qa-history?limit=100&saved=true", { cache: "no-store", signal: controller.signal });
        const payload = await response.json();
        if (!response.ok || !Array.isArray(payload.entries)) throw new Error(payload.error || "Unable to restore saved responses");
        if (!controller.signal.aborted) setSavedData((current) => {
          const entries = (payload.entries as ClientHistoryEntry[]).map(mapSavedHistory);
          return [...current, ...entries.filter((entry) => !current.some((existing) => existing.id === entry.id))].slice(0, 100);
        });
      } catch (error) {
        if (!controller.signal.aborted) setHistoryError(error instanceof Error ? error.message : "Unable to restore saved responses");
      }
    };
    void restore();
    return () => controller.abort();
  }, []);

  return (
    <div className="w-full">
      <Copilot addInSavedData={addInSavedData} />
      {historyError && <div className="mx-auto max-w-7xl px-6 text-xs text-rose-400">{historyError}</div>}
      {savedData.length > 0 && (
        <div className="mx-auto max-w-7xl px-6 pb-12">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setHistoryOpen((value) => !value)}
            className="mt-5 h-9 w-full justify-between border border-slate-800 bg-slate-950/50 px-4 text-xs text-slate-400 hover:text-slate-200"
          >
            <span className="flex items-center gap-2"><HistoryIcon className="h-3.5 w-3.5 text-indigo-400" /> Saved responses ({savedData.length})</span>
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${historyOpen ? "rotate-180" : ""}`} />
          </Button>
          {historyOpen && <History data={savedData} deleteData={deleteData} />}
        </div>
      )}
      <ChatbotPopup />
    </div>
  );
}

