import { NextRequest, NextResponse } from "next/server";
import type { KnowledgeDocumentType } from "@/lib/knowledge/types";
import {
  addKnowledgeSource,
  clearKnowledgePack,
  deleteKnowledgeSource,
  readKnowledgePack,
  replaceKnowledgePack,
} from "@/lib/server/knowledgeStore";
import { extractKnowledgeSourceWithData } from "@/lib/server/knowledgeExtractor";
import { DEFAULT_KNOWLEDGE_BASE_ID } from "@/lib/server/db/migrations";
import { KnowledgeBaseError, knowledgeBaseRepository } from "@/lib/server/repositories/knowledgeBaseRepository";

export const runtime = "nodejs";

const VALID_TYPES = new Set<KnowledgeDocumentType>([
  "resume",
  "job_description",
  "project",
  "notes",
  "other",
]);


function validateImportedPack(pack: any): string | null {
  let size = 0;
  try { size = JSON.stringify(pack).length; } catch { return "Candidate Knowledge Pack must be valid JSON"; }
  if (size > 2_000_000) return "Candidate Knowledge Pack exceeds the 2 MB import limit";
  if (!pack?.profile || typeof pack.profile !== "object") return "Candidate Knowledge Pack profile is required";
  if (!Array.isArray(pack.projects) || !Array.isArray(pack.experience) || !Array.isArray(pack.sources)) {
    return "Invalid Candidate Knowledge Pack structure";
  }
  if (pack.projects.length > 100 || pack.experience.length > 100 || pack.sources.length > 100) {
    return "Candidate Knowledge Pack exceeds the supported item limits";
  }
  for (const project of pack.projects) {
    if (!project || typeof project !== "object" || typeof project.name !== "string" || !project.name.trim()) {
      return "Every project must have a non-empty name";
    }
    for (const key of ["technologies", "decisions", "challenges", "metrics", "lessons", "answerHooks", "examples"]) {
      if (project[key] != null && !Array.isArray(project[key])) return `Project ${project.name}: ${key} must be an array`;
    }
  }
  for (const source of pack.sources) {
    if (!source || typeof source !== "object" || typeof source.id !== "string" || typeof source.filename !== "string") {
      return "Every knowledge source must have id and filename strings";
    }
    if (!VALID_TYPES.has(source.type as KnowledgeDocumentType)) return `Invalid knowledge source type for ${source.filename}`;
  }
  return null;
}

function clientView(pack: Awaited<ReturnType<typeof readKnowledgePack>>, baseId: string) {
  const availability = knowledgeBaseRepository.sourceAvailability(baseId);
  return {
    version: pack.version,
    updatedAt: pack.updatedAt,
    profile: pack.profile,
    targetRole: pack.targetRole,
    stats: {
      sources: pack.sources.length,
      experience: pack.experience.length,
      projects: pack.projects.length,
      skills: pack.skills.length,
      facts: pack.facts.length,
    },
    keyterms: Array.from(
      new Set([
        ...pack.skills,
        ...pack.projects.flatMap((project) => [
          project.name,
          ...project.technologies,
          ...(project.answerHooks || []),
          ...(project.examples || []).flatMap((example) => example.relevance || []),
        ]),
        ...pack.sources.flatMap((source) => source.keywords || []),
      ].map((value) => value?.trim()).filter(Boolean)),
    ).slice(0, 40),
    sources: pack.sources.map(({ contribution: _contribution, rawExcerpt: _rawExcerpt, ...source }) => ({ ...source, hasOriginal: availability[source.id] === true })),
  };
}

export async function GET(request: Request) {
  try {
    const parameters = new URL(request.url).searchParams;
    const baseId = parameters.get("baseId") ?? DEFAULT_KNOWLEDGE_BASE_ID;
    knowledgeBaseRepository.require(baseId);
    if (parameters.get("download") === "1") {
      const original = knowledgeBaseRepository.original(baseId, parameters.get("sourceId") ?? "");
      const filename = original.filename.replace(/[\x00-\x1f\x7f"\\/]/g, "_").slice(0, 200) || "source";
      const asciiFilename = filename.replace(/[^\x20-\x7e]/g, "_");
      const encodedFilename = encodeURIComponent(filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      return new Response(new Uint8Array(original.bytes), { headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      } });
    }
    const pack = await readKnowledgePack(baseId);
    return NextResponse.json(clientView(pack, baseId), { headers: { "Cache-Control": "no-store" } });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "Failed to load knowledge" }, { status: error instanceof KnowledgeBaseError ? error.status : 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const baseId = new URL(request.url).searchParams.get("baseId") ?? formData.get("baseId") ?? DEFAULT_KNOWLEDGE_BASE_ID;
    if (typeof baseId !== "string") throw new KnowledgeBaseError("Invalid knowledge base id");
    knowledgeBaseRepository.require(baseId);
    const file = formData.get("file");
    const requestedType = String(formData.get("documentType") || "other") as KnowledgeDocumentType;

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "A knowledge document is required" }, { status: 400 });
    }
    if (!VALID_TYPES.has(requestedType)) {
      return NextResponse.json({ error: "Invalid document type" }, { status: 400 });
    }

    const { source, documentData } = await extractKnowledgeSourceWithData(file, requestedType);
    const pack = await addKnowledgeSource(source, documentData, baseId);
    return NextResponse.json({
      message: "Candidate Knowledge Pack updated",
      source: { id: source.id, filename: source.filename, type: source.type, summary: source.summary },
      pack: clientView(pack, baseId),
    });
  } catch (error: any) {
    if (!(error instanceof KnowledgeBaseError)) console.error("[knowledge] upload failed", error);
    const message = error?.message || "Failed to process the knowledge document";
    const status = error instanceof KnowledgeBaseError ? error.status : /required|empty|supported|limit|extractable|invalid/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const baseId = new URL(request.url).searchParams.get("baseId") ?? body?.baseId ?? DEFAULT_KNOWLEDGE_BASE_ID;
    knowledgeBaseRepository.require(baseId);
    const pack = body?.pack;
    if (!pack || typeof pack !== "object") {
      return NextResponse.json({ error: "A Candidate Knowledge Pack JSON object is required" }, { status: 400 });
    }
    const validationError = validateImportedPack(pack);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
    const normalized = await replaceKnowledgePack(pack, baseId);
    return NextResponse.json({ message: "Candidate Knowledge Pack imported", pack: clientView(normalized, baseId) });
  } catch (error: any) {
    if (!(error instanceof KnowledgeBaseError)) console.error("[knowledge] pack import failed", error);
    return NextResponse.json({ error: error?.message || "Failed to import Candidate Knowledge Pack" }, { status: error instanceof KnowledgeBaseError ? error.status : 400 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const sourceId = new URL(request.url).searchParams.get("sourceId");
    const baseId = new URL(request.url).searchParams.get("baseId") ?? DEFAULT_KNOWLEDGE_BASE_ID;
    knowledgeBaseRepository.require(baseId);
    if (!sourceId) {
      const pack = await clearKnowledgePack(baseId);
      return NextResponse.json({ message: "Candidate Knowledge Pack cleared", pack: clientView(pack, baseId) });
    }

    const pack = await deleteKnowledgeSource(sourceId, baseId);
    return NextResponse.json({ message: "Knowledge source removed", pack: clientView(pack, baseId) });
  } catch (error: any) {
    const status = error instanceof KnowledgeBaseError ? error.status : /not found/i.test(error?.message || "") ? 404 : 500;
    return NextResponse.json({ error: error?.message || "Failed to remove knowledge source" }, { status });
  }
}
