import { settingsRepository, SettingsConflictError } from "@/lib/server/repositories/settingsRepository";
export const runtime = "nodejs";
export async function GET() {
  try { return Response.json({ settings: settingsRepository.getAll() }); }
  catch { return Response.json({ error: "Unable to load settings" }, { status: 503 }); }
}
export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (body.expectedRevisions !== undefined && (!body.expectedRevisions || typeof body.expectedRevisions !== "object" || Array.isArray(body.expectedRevisions))) throw new Error("Invalid revisions");
    return Response.json({ committed: true, settings: settingsRepository.upsert(body.patch, body.expectedRevisions) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Settings save failed" }, { status: error instanceof SettingsConflictError ? 409 : 400 });
  }
}
export const PUT = POST;