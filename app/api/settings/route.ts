import { settingsRepository } from "@/lib/server/repositories/settingsRepository";
export const runtime = "nodejs";
export async function GET() {
  try { return Response.json({ settings: settingsRepository.getAll() }); }
  catch { return Response.json({ error: "Unable to load settings" }, { status: 503 }); }
}
export async function POST(request: Request) {
  try {
    const body = await request.json();
    return Response.json({ committed: true, settings: settingsRepository.upsert(body.patch) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Settings save failed" }, { status: 400 });
  }
}
export const PUT = POST;