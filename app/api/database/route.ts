import { NextResponse } from "next/server";
import { MaintenanceError, MaintenanceRepository } from "@/lib/server/repositories/maintenanceRepository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  if (error instanceof MaintenanceError) return NextResponse.json({ error: error.message }, { status: error.status });
  return NextResponse.json({ error: "Database maintenance unavailable" }, { status: 500 });
}

function createDatabaseHandlers(repository: MaintenanceRepository) {
  return {
    async GET(request: Request) {
      try {
        const backup = new URL(request.url).searchParams.get("backup");
        if (backup !== null) {
          const exported = repository.exportBackup(backup);
          return new Response(exported.stream, { headers: { "Content-Type": "application/vnd.sqlite3", "Content-Length": String(exported.bytes), "Content-Disposition": `attachment; filename="${exported.id}"`, "Cache-Control": "no-store" } });
        }
        return NextResponse.json(repository.stats(), { headers: { "Cache-Control": "no-store" } });
      } catch (error) { return errorResponse(error); }
    },
    async POST(request: Request) {
      try {
        if (Number(request.headers.get("content-length")) > 4096) throw new MaintenanceError("Maintenance request too large", 413);
        const reader = request.body?.getReader();
        if (!reader) throw new MaintenanceError("Missing request body");
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 4096) { await reader.cancel(); throw new MaintenanceError("Maintenance request too large", 413); }
          chunks.push(chunk.value);
        }
        let body: { action?: unknown; id?: unknown };
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new MaintenanceError("Invalid JSON body"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new MaintenanceError("Invalid maintenance request");
        if (body.action === "backup") return NextResponse.json(await repository.backup());
        if (body.action === "rebuild") return NextResponse.json(repository.rebuildSearchIndex());
        if (body.action === "restore") {
          if (typeof body.id !== "string") throw new MaintenanceError("A local backup id is required");
          return NextResponse.json(repository.restoreInstructions(body.id), { status: 409 });
        }
        throw new MaintenanceError("Unknown maintenance action");
      } catch (error) { return errorResponse(error); }
    },
  };
}

const handlers = createDatabaseHandlers(new MaintenanceRepository());
export const GET = handlers.GET;
export const POST = handlers.POST;