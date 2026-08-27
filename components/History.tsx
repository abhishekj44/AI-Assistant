"use client";

import { Card } from "@/components/ui/card";
import { ContentData } from "./ui/content";
import { HistoryData } from "@/lib/types";
import { Clock, HelpCircle, Trash2, History as HistoryIcon } from "lucide-react";

interface HistoryProps {
  data: HistoryData[];
  deleteData: (createdAt: string) => void;
}

export default function History({ data: savedData, deleteData }: HistoryProps) {
  if (!savedData || savedData.length === 0) return null;

  return (
    <div className="w-full space-y-4 pt-6">
      <div className="flex items-center gap-2 border-b border-slate-800 pb-3">
        <HistoryIcon className="w-4 h-4 text-indigo-400" />
        <h3 className="text-sm font-semibold text-slate-200">Saved Responses History</h3>
        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
          {savedData.length}
        </span>
      </div>

      <div className="grid gap-3">
        {savedData.map((data, index) => (
          <Card key={index} className="p-4 bg-slate-950/70 border-slate-800/80 rounded-xl shadow-sm text-slate-200">
            <div className="flex items-center justify-between text-xs text-slate-400 border-b border-slate-900 pb-2 mb-2">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-400 font-medium text-[11px] border border-indigo-500/20">
                  {data.tag}
                </span>
                <span className="flex items-center gap-1 text-slate-500 text-[11px]">
                  <Clock className="w-3 h-3" />
                  {new Date(data.createdAt).toLocaleTimeString()}
                </span>
              </div>
              <button
                className="text-rose-400 hover:text-rose-300 transition-colors flex items-center gap-1 text-[11px]"
                onClick={() => deleteData(data.createdAt)}
              >
                <Trash2 className="w-3 h-3" /> Delete
              </button>
            </div>
            {data.question && (
              <div className="mb-3 rounded-lg border border-indigo-500/20 bg-indigo-950/30 px-3 py-2">
                <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-semibold text-indigo-400">
                  <HelpCircle className="h-3 w-3" /> Question
                </div>
                <p className="text-xs italic text-indigo-200/80">&ldquo;{data.question}&rdquo;</p>
              </div>
            )}
            <ContentData className="text-sm text-slate-300 leading-relaxed font-sans" contentMaxLength={200}>
              {data.data}
            </ContentData>
          </Card>
        ))}
      </div>
    </div>
  );
}
