import { NextRequest, NextResponse } from "next/server";
import type { KnowledgeDocumentType } from "@/lib/knowledge/types";
import {
  addKnowledgeSource,
  clearKnowledgePack,
  deleteKnowledgeSource,
  readKnowledgePack,
  replaceKnowledgePack,
} from "@/lib/server/knowledgeStore";
import { extractKnowledgeSource } from "@/lib/server/knowledgeExtractor";

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

function clientView(pack: Awaited<ReturnType<typeof readKnowledgePack>>) {
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
    sources: pack.sources.map(({ contribution: _contribution, rawExcerpt: _rawExcerpt, ...source }) => source),
  };
}

export async function GET() {
  const pack = await readKnowledgePack();
  return NextResponse.json(clientView(pack));
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const requestedType = String(formData.get("documentType") || "other") as KnowledgeDocumentType;

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "A knowledge document is required" }, { status: 400 });
    }
    if (!VALID_TYPES.has(requestedType)) {
      return NextResponse.json({ error: "Invalid document type" }, { status: 400 });
    }

    const source = await extractKnowledgeSource(file, requestedType);
    const pack = await addKnowledgeSource(source);
    return NextResponse.json({
      message: "Candidate Knowledge Pack updated",
      source: { id: source.id, filename: source.filename, type: source.type, summary: source.summary },
      pack: clientView(pack),
    });
  } catch (error: any) {
    console.error("[knowledge] upload failed", error);
    const message = error?.message || "Failed to process the knowledge document";
    const status = /required|empty|supported|limit|extractable|invalid/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const pack = body?.pack;
    if (!pack || typeof pack !== "object") {
      return NextResponse.json({ error: "A Candidate Knowledge Pack JSON object is required" }, { status: 400 });
    }
    const validationError = validateImportedPack(pack);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }
    const normalized = await replaceKnowledgePack(pack);
    return NextResponse.json({ message: "Candidate Knowledge Pack imported", pack: clientView(normalized) });
  } catch (error: any) {
    console.error("[knowledge] pack import failed", error);
    return NextResponse.json({ error: error?.message || "Failed to import Candidate Knowledge Pack" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const sourceId = new URL(request.url).searchParams.get("sourceId");
    if (!sourceId) {
      const pack = await clearKnowledgePack();
      return NextResponse.json({ message: "Candidate Knowledge Pack cleared", pack: clientView(pack) });
    }

    const pack = await deleteKnowledgeSource(sourceId);
    return NextResponse.json({ message: "Knowledge source removed", pack: clientView(pack) });
  } catch (error: any) {
    const status = /not found/i.test(error?.message || "") ? 404 : 500;
    return NextResponse.json({ error: error?.message || "Failed to remove knowledge source" }, { status });
  }
}
