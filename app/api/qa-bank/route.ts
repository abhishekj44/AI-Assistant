import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_KNOWLEDGE_BASE_ID } from "@/lib/server/db/migrations";
import { KnowledgeBaseError, knowledgeBaseRepository } from "@/lib/server/repositories/knowledgeBaseRepository";
import {
  clearQABank,
  deleteQAEntry,
  importQABank,
  readQABank,
  upsertQAEntry,
} from "@/lib/server/qaStore";

export const runtime = "nodejs";

function clientView(bank: Awaited<ReturnType<typeof readQABank>>) {
  return {
    version: bank.version,
    updatedAt: bank.updatedAt,
    count: bank.entries.length,
    enabledCount: bank.entries.filter((entry) => entry.enabled).length,
    entries: bank.entries,
  };
}

export async function GET(request: Request) {
  try {
    const baseId = new URL(request.url).searchParams.get("baseId") ?? DEFAULT_KNOWLEDGE_BASE_ID;
    return NextResponse.json(clientView(await readQABank(baseId)), { headers: { "Cache-Control": "no-store" } });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Failed to load Q&A bank" }, { status: error instanceof KnowledgeBaseError ? error.status : 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const baseId = new URL(request.url).searchParams.get("baseId") ?? body?.baseId ?? DEFAULT_KNOWLEDGE_BASE_ID;
    knowledgeBaseRepository.require(baseId);
    const bank = await upsertQAEntry(body?.entry ?? body, baseId);
    return NextResponse.json({ message: "Q&A entry saved", bank: clientView(bank) });
  } catch (error: any) {
    const message = error?.message || "Failed to save Q&A entry";
    const status = error instanceof KnowledgeBaseError ? error.status : /required|same primary question|object|limit|exceeds/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const baseId = new URL(request.url).searchParams.get("baseId") ?? body?.baseId ?? DEFAULT_KNOWLEDGE_BASE_ID;
    knowledgeBaseRepository.require(baseId);
    const mode = body?.mode === "replace" ? "replace" : "merge";
    const bank = await importQABank(body?.bank ?? body, mode, baseId);
    return NextResponse.json({ message: `Q&A bank ${mode === "replace" ? "replaced" : "merged"}`, bank: clientView(bank) });
  } catch (error: any) {
    const message = error?.message || "Failed to import Q&A bank";
    const status = error instanceof KnowledgeBaseError ? error.status : /no valid|cannot exceed|invalid|required|limit|exceeds|object/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const entryId = new URL(request.url).searchParams.get("entryId");
    const baseId = new URL(request.url).searchParams.get("baseId") ?? DEFAULT_KNOWLEDGE_BASE_ID;
    const bank = entryId ? await deleteQAEntry(entryId, baseId) : await clearQABank(baseId);
    return NextResponse.json({ message: entryId ? "Q&A entry removed" : "Q&A bank cleared", bank: clientView(bank) });
  } catch (error: any) {
    const status = error instanceof KnowledgeBaseError ? error.status : /not found/i.test(error?.message || "") ? 404 : 500;
    return NextResponse.json({ error: error?.message || "Failed to update Q&A bank" }, { status });
  }
}
