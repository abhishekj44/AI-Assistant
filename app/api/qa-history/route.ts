import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { ModelRunRepository } from "@/lib/server/repositories/modelRunRepository";
import { AnswerLibraryRepository } from "@/lib/server/repositories/answerLibraryRepository";
import { readQABank } from "@/lib/server/qaStore";

export const runtime = "nodejs";

async function repository() {
  await readQABank();
  const runs = new ModelRunRepository();
  return runs;
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : "Unable to update answer history";
  const status = /not found/i.test(message) ? 404 : /required|invalid/i.test(message) ? 400
    : /Good|completed|INTERVIEWEE|Prepared Q&A|approved/i.test(message) ? 409 : 500;
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const requested = Number(params.get("limit") || 50);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(Math.round(requested), 100)) : 50;
    const entries = (await repository()).history(limit, { savedOnly: params.get("saved") === "true", before: params.get("before") || undefined });
    return NextResponse.json({ entries }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const runs = await repository();
    if (typeof body.runId === "string") {
      const run = runs.get(body.runId);
      if (!run) throw new Error("Generated answer not found");
      if (run.status !== "COMPLETED") throw new Error("Only completed answers can be saved automatically");
      runs.setSaved(run.id, true);
      return NextResponse.json({ success: true, id: run.id });
    }
    if (typeof body.answer !== "string" || !body.answer.trim()) throw new Error("Answer is required");
    const id = typeof body.id === "string" ? body.id : crypto.randomUUID();
    runs.importHistory([{ ...body, id, createdAt: typeof body.createdAt === "string" ? body.createdAt : new Date().toISOString() }]);
    return NextResponse.json({ success: true, id });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    if (typeof body.id !== "string") throw new Error("Answer id is required");
    const runs = await repository();
    if (typeof body.saved === "boolean") {
      runs.setSaved(body.id, body.saved);
      return NextResponse.json({ success: true });
    }
    if (body.feedback !== "good" && body.feedback !== "poor") throw new Error("Feedback must be good or poor");
    runs.rate(body.id, body.feedback);
    return NextResponse.json({ success: true, feedback: body.feedback });
  } catch (error) { return failure(error); }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    if (typeof body.id !== "string") throw new Error("Answer id is required");
    await repository();
    const promoted = new AnswerLibraryRepository().promoteRun(body.id, typeof body.baseId === "string" ? body.baseId : undefined);
    return NextResponse.json({ success: true, qaEntryId: promoted.entryId, alreadyExists: promoted.alreadyExists });
  } catch (error) { return failure(error); }
}
