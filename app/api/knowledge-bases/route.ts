import { NextResponse } from "next/server";
import { DEFAULT_KNOWLEDGE_BASE_ID } from "@/lib/server/db/migrations";
import { KnowledgeBaseError, knowledgeBaseRepository } from "@/lib/server/repositories/knowledgeBaseRepository";

export const runtime = "nodejs";

function failure(error: unknown) {
  if (error instanceof KnowledgeBaseError) return NextResponse.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError || error instanceof TypeError) return NextResponse.json({ error: "Invalid knowledge base request" }, { status: 400 });
  console.error("Knowledge base operation failed", error);
  return NextResponse.json({ error: "Knowledge base storage unavailable" }, { status: 500 });
}

export async function GET() {
  try { return NextResponse.json({ bases: knowledgeBaseRepository.list(), defaultBaseId: DEFAULT_KNOWLEDGE_BASE_ID }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return NextResponse.json({ base: knowledgeBaseRepository.create(body) }, { status: 201 });
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const baseId = new URL(request.url).searchParams.get("baseId") ?? body?.baseId;
    if (baseId === undefined) throw new KnowledgeBaseError("Knowledge base id is required");
    return NextResponse.json({ base: knowledgeBaseRepository.update(baseId, body) });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  try {
    const baseId = new URL(request.url).searchParams.get("baseId");
    if (baseId === null) throw new KnowledgeBaseError("Knowledge base id is required");
    knowledgeBaseRepository.delete(baseId);
    return NextResponse.json({ success: true });
  } catch (error) { return failure(error); }
}