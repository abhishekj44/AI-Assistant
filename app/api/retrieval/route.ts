import { RetrievalRepository, type RetrievalSourceKind } from "@/lib/server/repositories/retrievalRepository";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const parameters = new URL(request.url).searchParams;
  const query = parameters.get("q")?.trim() || "";
  if (!query || query.length > 4000) return Response.json({ error: "Search query must contain 1 to 4000 characters" }, { status: 400 });
  const requested = parameters.get("kinds")?.split(",") as RetrievalSourceKind[] | undefined;
  if (requested?.some(kind => !["ENTRY", "DOCUMENT", "QA", "QUESTION", "SUMMARY", "TRANSCRIPT"].includes(kind))) return Response.json({ error: "Invalid search source kind" }, { status: 400 });
  const started = performance.now();
  try {
    const items = new RetrievalRepository().retrieve(query, { sessionId: parameters.get("sessionId") || undefined,
      baseIds: parameters.has("baseId") ? parameters.getAll("baseId") : undefined, sourceKinds: requested,
      contextHint: parameters.get("context")?.slice(0, 4000), limit: 20, tokenBudget: 5000 });
    return Response.json({ engine: "sqlite-fts5", elapsedMs: Math.round(performance.now() - started), items }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Search unavailable" }, { status: 500 }); }
}