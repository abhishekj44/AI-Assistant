"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, History as HistoryIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Copilot } from "@/components/copilot";
import type { HistoryData } from "@/lib/types";

const History = dynamic(() => import("@/components/History"), { ssr: false });

export default function MainPage() {
  const isRendered = useRef(false);
  const [savedData, setSavedData] = useState<HistoryData[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  const addInSavedData = (data: HistoryData) => {
    setSavedData((prevData) => [data, ...prevData].slice(0, 100));
  };

  const deleteData = (createdAt: string) => {
    setSavedData((prevData) => prevData.filter((data) => data.createdAt !== createdAt));
  };

  useEffect(() => {
    if (isRendered.current) return;
    isRendered.current = true;
    try {
      const raw = localStorage.getItem("savedData");
      if (raw) {
        const parsed = JSON.parse(raw) as HistoryData[];
        setSavedData(Array.isArray(parsed) ? parsed.slice(0, 100) : []);
      }
    } catch {
      localStorage.removeItem("savedData");
      setSavedData([]);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem("savedData", JSON.stringify(savedData.slice(0, 100)));
    } catch {
      // Storage quota errors must never interrupt the live meeting UI.
    }
  }, [savedData]);

  return (
    <div className="w-full">
      <Copilot addInSavedData={addInSavedData} />
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
    </div>
  );
}
