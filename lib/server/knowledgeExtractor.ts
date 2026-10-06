import { GoogleGenAI, ThinkingLevel, type GenerateContentParameters } from "@google/genai";
import crypto from "node:crypto";
import type {
  CandidateProjectExample,
  KnowledgeContribution,
  KnowledgeDocumentType,
  KnowledgeSource,
} from "@/lib/knowledge/types";
import { safePdfParse } from "@/lib/safePdfParse";
import { renderRuntimePrompt } from "./runtimePrompts";
import { promptRepository, type PromptRepository } from "./repositories/promptRepository";
import { ModelRunRepository } from "./repositories/modelRunRepository";
import type { KnowledgeDocumentData } from "./repositories/knowledgeRepository";

const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 90_000;
const MAX_RAW_EXCERPT_CHARS = 6_000;

export interface ExtractionOptions {
  promptRepository?: PromptRepository;
  modelRunRepository?: ModelRunRepository;
  generateContent?: (parameters: GenerateContentParameters) => Promise<{ text?: string }>;
  signal?: AbortSignal;
}

function normalizeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sanitizeExamples(value: unknown): CandidateProjectExample[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      title: typeof item.title === "string" ? item.title.trim() : "",
      situation: typeof item.situation === "string" ? item.situation.trim() : undefined,
      approach: typeof item.approach === "string" ? item.approach.trim() : undefined,
      result: typeof item.result === "string" ? item.result.trim() : undefined,
      relevance: normalizeArray(item.relevance).slice(0, 12),
    }))
    .filter((item) => item.title && (item.situation || item.approach || item.result))
    .slice(0, 8);
}

function sanitizeContribution(value: any): KnowledgeContribution {
  const experience = Array.isArray(value?.experience)
    ? value.experience.map((item: any) => ({
        company: typeof item?.company === "string" ? item.company : undefined,
        role: typeof item?.role === "string" ? item.role : undefined,
        period: typeof item?.period === "string" ? item.period : undefined,
        responsibilities: normalizeArray(item?.responsibilities),
        achievements: normalizeArray(item?.achievements),
        technologies: normalizeArray(item?.technologies),
      }))
    : [];

  const projects = Array.isArray(value?.projects)
    ? value.projects
        .filter((item: any) => typeof item?.name === "string" && item.name.trim())
        .map((item: any) => ({
          name: item.name.trim(),
          problem: typeof item?.problem === "string" ? item.problem : undefined,
          role: typeof item?.role === "string" ? item.role : undefined,
          architecture: typeof item?.architecture === "string" ? item.architecture : undefined,
          technologies: normalizeArray(item?.technologies),
          decisions: Array.isArray(item?.decisions)
            ? item.decisions
                .filter((d: any) => typeof d?.decision === "string")
                .map((d: any) => ({
                  decision: d.decision,
                  reason: typeof d?.reason === "string" ? d.reason : undefined,
                  tradeoffs: normalizeArray(d?.tradeoffs),
                }))
            : [],
          challenges: Array.isArray(item?.challenges)
            ? item.challenges
                .filter((c: any) => typeof c?.challenge === "string")
                .map((c: any) => ({
                  challenge: c.challenge,
                  solution: typeof c?.solution === "string" ? c.solution : undefined,
                  result: typeof c?.result === "string" ? c.result : undefined,
                }))
            : [],
          metrics: normalizeArray(item?.metrics),
          lessons: normalizeArray(item?.lessons),
          answerHooks: normalizeArray(item?.answerHooks).slice(0, 30),
          examples: sanitizeExamples(item?.examples),
        }))
    : [];

  return {
    profile: value?.profile
      ? {
          headline: typeof value.profile.headline === "string" ? value.profile.headline : undefined,
          summary: typeof value.profile.summary === "string" ? value.profile.summary : undefined,
          strengths: normalizeArray(value.profile.strengths),
        }
      : undefined,
    targetRole: value?.targetRole
      ? {
          title: typeof value.targetRole.title === "string" ? value.targetRole.title : undefined,
          company: typeof value.targetRole.company === "string" ? value.targetRole.company : undefined,
          priorities: normalizeArray(value.targetRole.priorities),
          requirements: normalizeArray(value.targetRole.requirements),
        }
      : undefined,
    experience,
    projects,
    skills: normalizeArray(value?.skills),
    achievements: normalizeArray(value?.achievements),
    facts: normalizeArray(value?.facts),
  };
}

async function extractText(file: File, bytes: Buffer): Promise<string> {
  if (file.size <= 0) throw new Error("File is empty");
  if (file.size > MAX_FILE_BYTES) throw new Error("File exceeds the 12 MB upload limit");

  const lowerName = file.name.toLowerCase();
  if (file.type === "application/pdf" || lowerName.endsWith(".pdf")) {
    const parsed = await safePdfParse(bytes);
    const text = String(parsed?.text || "").trim();
    if (!text) throw new Error("No extractable text was found in this PDF");
    return text;
  }

  if (
    file.type.startsWith("text/") ||
    lowerName.endsWith(".txt") ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".json")
  ) {
    const text = bytes.toString("utf8").trim();
    if (!text) throw new Error("The uploaded document is empty");
    return text;
  }

  throw new Error("Supported knowledge files are PDF, TXT, MD, and JSON");
}

async function callExtractor(documentText: string, documentType: KnowledgeDocumentType, options: ExtractionOptions): Promise<any> {
  const model = process.env.KNOWLEDGE_EXTRACTION_MODEL || "gemini-3.5-flash-lite";
  const rendered = renderRuntimePrompt("EXTRACTION", undefined, { documentType, documentText: documentText.slice(0, MAX_DOCUMENT_CHARS) }, options.promptRepository ?? promptRepository);
  const runs = options.modelRunRepository ?? new ModelRunRepository();
  const requestId = runs.createRequest({ ...rendered, mode: rendered.mode ?? undefined, purpose: "EXTRACTION", context: { documentType, promptVersion: rendered.promptVersion } });
  const runId = runs.start({ requestId, provider: "gemini", model, tag: "Knowledge Extraction" });
  let output = "";
  try {
    options.signal?.throwIfAborted();
    const generateContent = options.generateContent ?? (async (parameters: GenerateContentParameters) => {
      const apiKey = process.env.GEMINI_API_KEY?.trim();
      if (!apiKey) throw new Error("GEMINI_API_KEY is required to build the Candidate Knowledge Pack");
      const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: process.env.GEMINI_API_VERSION || "v1" } });
      return client.models.generateContent(parameters);
    });
    const response = await generateContent({
    model,
    contents: rendered.prompt,
    config: {
      systemInstruction: rendered.systemInstruction,
      abortSignal: options.signal,
      httpOptions: { timeout: 60_000 },
      responseMimeType: "application/json",
      maxOutputTokens: 5_000,
      thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
    },
    });
    output = response.text?.trim() ?? "";
    options.signal?.throwIfAborted();
    if (!output) throw new Error("Knowledge extraction model returned an empty response");
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      const firstBrace = output.indexOf("{");
      const lastBrace = output.lastIndexOf("}");
      if (firstBrace < 0 || lastBrace <= firstBrace) throw new Error("Knowledge extraction model returned invalid JSON");
      parsed = JSON.parse(output.slice(firstBrace, lastBrace + 1));
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Knowledge extraction model returned invalid JSON");
    runs.finish(runId, { status: "COMPLETED", output });
    return parsed;
  } catch (error) {
    runs.finish(runId, { status: options.signal?.aborted || error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? "INTERRUPTED" : "FAILED", output, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function extractKnowledgeSource(
  file: File,
  documentType: KnowledgeDocumentType,
  options: ExtractionOptions = {},
): Promise<KnowledgeSource> {
  return (await extractKnowledgeSourceWithData(file, documentType, options)).source;
}

export async function extractKnowledgeSourceWithData(
  file: File,
  documentType: KnowledgeDocumentType,
  options: ExtractionOptions = {},
): Promise<{ source: KnowledgeSource; documentData: KnowledgeDocumentData }> {
  if (file.size <= 0) throw new Error("File is empty");
  if (file.size > MAX_FILE_BYTES) throw new Error("File exceeds the 12 MB upload limit");
  const bytes = Buffer.from(await file.arrayBuffer());
  const text = await extractText(file, bytes);
  const extracted = await callExtractor(text, documentType, options);
  const contribution = sanitizeContribution(extracted);
  const facts = normalizeArray(extracted?.facts);
  const keywords = normalizeArray(extracted?.keywords).slice(0, 40);
  const sourceSummary =
    typeof extracted?.sourceSummary === "string" && extracted.sourceSummary.trim()
      ? extracted.sourceSummary.trim()
      : text.slice(0, 500).replace(/\s+/g, " ");

  const source: KnowledgeSource = {
    id: `src_${crypto.randomUUID()}`,
    filename: file.name,
    type: documentType,
    uploadedAt: new Date().toISOString(),
    summary: sourceSummary,
    facts,
    keywords,
    rawExcerpt: text.slice(0, MAX_RAW_EXCERPT_CHARS),
    contribution,
  };
  return { source, documentData: { bytes, mimeType: file.type, text } };
}
