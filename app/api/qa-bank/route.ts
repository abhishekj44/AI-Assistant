import { NextRequest, NextResponse } from "next/server";
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

export async function GET() {
  return NextResponse.json(clientView(await readQABank()), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const bank = await upsertQAEntry(body?.entry ?? body);
    return NextResponse.json({ message: "Q&A entry saved", bank: clientView(bank) });
  } catch (error: any) {
    const message = error?.message || "Failed to save Q&A entry";
    const status = /required|same primary question|object/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const mode = body?.mode === "replace" ? "replace" : "merge";
    const bank = await importQABank(body?.bank ?? body, mode);
    return NextResponse.json({ message: `Q&A bank ${mode === "replace" ? "replaced" : "merged"}`, bank: clientView(bank) });
  } catch (error: any) {
    const message = error?.message || "Failed to import Q&A bank";
    const status = /no valid|cannot exceed|invalid/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const entryId = new URL(request.url).searchParams.get("entryId");
    const bank = entryId ? await deleteQAEntry(entryId) : await clearQABank();
    return NextResponse.json({ message: entryId ? "Q&A entry removed" : "Q&A bank cleared", bank: clientView(bank) });
  } catch (error: any) {
    const status = /not found/i.test(error?.message || "") ? 404 : 500;
    return NextResponse.json({ error: error?.message || "Failed to update Q&A bank" }, { status });
  }
}
