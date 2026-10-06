import { BrowserImportRepository } from "@/lib/server/repositories/browserImportRepository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    if (Number(request.headers.get("content-length")) > 8_000_000) return Response.json({ error: "Import exceeds limit" }, { status: 413 });
    const text = await request.text();
    if (Buffer.byteLength(text) > 8_000_000) return Response.json({ error: "Import exceeds limit" }, { status: 413 });
    const body = JSON.parse(text);
    if (!Array.isArray(body.sessions)) return Response.json({ error: "Sessions array is required" }, { status: 400 });
    const ids = new BrowserImportRepository().importSessions(body.sessions, new URL(request.url).origin);
    return Response.json({ committed: true, sessionIds: ids });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Browser session import failed";
    return Response.json({ error: message }, { status: /owned|overwrite/i.test(message) ? 409 : 400 });
  }
}