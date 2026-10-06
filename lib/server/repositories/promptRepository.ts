import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getDatabase } from "../db/connection";
import { getCallPromptTemplate } from "../../prompts";
import { getSummarizerSystemPrompt, getSummarizerUserPrompt } from "../../prompts/summarizer";
import { getMemorySystemPrompt, buildMemoryUserPrompt } from "../../prompts/memory";
import { KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT, buildKnowledgeExtractionPrompt } from "../../prompts/knowledgeExtraction";
import type { CallType } from "../../callTypes";

export type PromptPurpose = "ANSWER" | "SUMMARY" | "MEMORY" | "EXTRACTION" | "CHAT";
export type PromptMode = "INTERVIEWER" | "INTERVIEWEE" | "MEETING";
export interface PromptRow {
  id: string; template_key: string; purpose: PromptPurpose; mode: PromptMode | null;
  variant: "standard" | "course_admission"; version: number; system_template: string;
  user_template: string; parameters: Record<string, unknown>; active: number; created_at: string;
}
export class PromptConflictError extends Error {}
export const CHAT_SYSTEM_INSTRUCTION = `You are a helpful, versatile AI Assistant and Copilot embedded in an interview preparation and meeting platform.

You have access to the user's Candidate Knowledge (profile, projects, skills, experience) when relevant.

How to respond:
1. General Questions & Conversations:
   - Answer the user's actual question directly, conversationally, and concisely.
   - Do NOT format regular questions into the "Interviewer Evaluation & Follow-up" format. Provide direct, helpful answers.

2. Technical & Architecture Questions:
   - Answer technical queries (Python, FastAPI, Temporal, RAG, Vector DBs, AI Agents, System Design, OAuth/Security, etc.) with senior engineering depth, clarity, and practical trade-offs.

3. Questions About Candidate Background:
   - When asked about projects, experience, or skills, use the facts from CANDIDATE_KNOWLEDGE. Be accurate and never invent personal claims.

4. Candidate Evaluation (ONLY when explicitly asked):
   - ONLY if the user explicitly asks you to evaluate a candidate's response or generate interview follow-up questions for a candidate's statement, format your response into:
     - 🔍 Candidate Answer Evaluation & Technical Fact-Check
     - 🎯 Primary Follow-Up Question
     - 🔀 Topic-Switch Follow-Up Question

Tone:
- Direct, intelligent, and conversational.
- Use clean markdown formatting (bullet points, bold text, code blocks) when helpful.`;

type StoredPrompt = Omit<PromptRow, "parameters"> & { parameters_json: string };
function decode(row: StoredPrompt): PromptRow {
  const { parameters_json, ...rest } = row;
  return { ...rest, parameters: JSON.parse(parameters_json) };
}
const PLACEHOLDERS: Record<PromptPurpose, string[]> = { ANSWER: ["question", "background", "memory", "sessionContext", "transcript", "candidateContext", "jobDescription", "candidateProfile"], SUMMARY: ["transcript", "jobDescription", "candidateProfile"], MEMORY: ["previousMemory", "recentTurns", "jobDescription", "candidateProfile"], EXTRACTION: ["documentType", "documentText"], CHAT: ["message", "history", "candidateContext"] };
function validateText(value: unknown, required = false, purpose?: PromptPurpose): asserts value is string {
  if (typeof value !== "string" || value.length > 50000 || (required && !value.trim()) || value.includes("\u0000")) throw new Error("Invalid prompt text");
  const allowed = new Set(purpose ? PLACEHOLDERS[purpose] : Object.values(PLACEHOLDERS).flat());
  for (const match of value.matchAll(/\{\{([^{}]+)\}\}/g)) if (!allowed.has(match[1])) throw new Error(`Unknown placeholder: ${match[1]}`);
  const remainder = value.replace(/\{\{([^{}]+)\}\}/g, "");
  if (remainder.includes("{{") || remainder.includes("}}") || value.includes("{{{") || value.includes("}}}")) throw new Error("Malformed placeholder");
}

export class PromptRepository {
  constructor(private readonly database?: Database.Database) {}
  private get db() { return this.database ?? getDatabase(); }
  seed(): void {
    const db = this.db;
    db.transaction(() => {
      const insert = db.prepare("INSERT OR IGNORE INTO prompts(id,template_key,purpose,mode,variant,version,system_template,user_template,parameters_json,active,created_at) VALUES (?,?,?,?,?,1,?,?,?,1,?)");
      const add = (key: string, purpose: PromptPurpose, mode: PromptMode | null, variant: string, system: string, user = "", parameters: unknown = {}) => insert.run(`seed:${key}:1`, key, purpose, mode, variant, system, user, JSON.stringify(parameters), new Date().toISOString());
      const modes: Array<[PromptMode, CallType]> = [["INTERVIEWER", "taking_interview"], ["INTERVIEWEE", "giving_interview"], ["MEETING", "meeting"]];
      for (const [mode, callType] of modes) {
        for (const variant of mode === "INTERVIEWER" ? ["standard", "course_admission"] as const : ["standard"] as const) {
          const template = getCallPromptTemplate({ callType, modeVariant: variant });
          add(`ANSWER:${mode}:${variant}`, "ANSWER", mode, variant, template.assistantIdentity, template.finalOutputInstruction, template);
        }
        add(`SUMMARY:${mode}:standard`, "SUMMARY", mode, "standard", getSummarizerSystemPrompt(callType), getSummarizerUserPrompt("{{transcript}}", callType));
        add(`MEMORY:${mode}:standard`, "MEMORY", mode, "standard", getMemorySystemPrompt(callType), buildMemoryUserPrompt("{{previousMemory}}", "{{recentTurns}}").replace('"{{previousMemory}}"', "{{previousMemory}}").replace('"{{recentTurns}}"', "{{recentTurns}}"));
      }
      add("EXTRACTION:global:standard", "EXTRACTION", null, "standard", KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT, buildKnowledgeExtractionPrompt("resume", "{{documentText}}").replace("Document type: resume", "Document type: {{documentType}}"));
      add("CHAT:global:standard", "CHAT", null, "standard", CHAT_SYSTEM_INSTRUCTION, "{{candidateContext}}{{history}}USER: {{message}}\n\nRespond helpfully and concisely as the ASSISTANT.");
    })();
  }
  list(activeOnly = true): PromptRow[] {
    this.seed();
    return (this.db.prepare(`SELECT * FROM prompts ${activeOnly ? "WHERE active=1" : ""} ORDER BY template_key,version`).all() as StoredPrompt[]).map(decode);
  }
  getActive(purpose: PromptPurpose, mode: PromptMode | null = null, variant = "standard"): PromptRow {
    if (!(purpose in PLACEHOLDERS) || !["standard", "course_admission"].includes(variant)) throw new Error("Invalid prompt purpose or variant");
    if (purpose === "CHAT" || purpose === "EXTRACTION" ? mode !== null || variant !== "standard" : !["INTERVIEWER", "INTERVIEWEE", "MEETING"].includes(mode ?? "") || variant === "course_admission" && mode !== "INTERVIEWER") throw new Error("Invalid prompt mode or variant");
    const rows = this.list();
    const row = rows.find((item) => item.purpose === purpose && item.mode === mode && item.variant === variant)
      ?? rows.find((item) => item.purpose === purpose && item.mode === mode && item.variant === "standard");
    if (!row) throw new Error("Prompt not found");
    return row;
  }
  update(input: { key?: string; id?: string; baseVersion: number; system_template: string; user_template: string; parameters?: Record<string, unknown>; purpose?: PromptPurpose; mode?: PromptMode | null; variant?: string; reset?: boolean }): PromptRow {
    if (!Number.isSafeInteger(input.baseVersion) || input.baseVersion < 1) throw new Error("baseVersion is required");
    const current = this.list().find((row) => input.key ? row.template_key === input.key : row.id === input.id);
    if (!current) {
      if (input.id && this.list(false).some((row) => row.id === input.id)) throw new PromptConflictError("Prompt changed; reload before saving");
      throw new Error("Prompt not found");
    }
    if (input.purpose !== undefined && input.purpose !== current.purpose || input.mode !== undefined && input.mode !== current.mode || input.variant !== undefined && input.variant !== current.variant) throw new Error("Prompt purpose, mode and variant are immutable");
    if (input.reset) {
      const source = this.list(false).find((row) => row.template_key === current.template_key && row.version === 1)!;
      input = { ...input, system_template: source.system_template, user_template: source.user_template, parameters: source.parameters };
    }
    validateText(input.system_template, true, current.purpose);
    validateText(input.user_template, false, current.purpose);
    const parameters = input.parameters ?? current.parameters;
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("Invalid prompt parameters");
    const encoded = JSON.stringify(parameters);
    if (encoded.length > 50000) throw new Error("Prompt parameters too large");
    const allowedFields = current.purpose === "ANSWER" ? Object.keys(current.parameters) : [];
    for (const [key, value] of Object.entries(parameters)) {
      if (!allowedFields.includes(key)) throw new Error(`Unknown prompt parameter: ${key}`);
      validateText(value, false, current.purpose);
      if ((key === "id" || key === "callType" || key === "confidencePolicy") && value !== current.parameters[key]) throw new Error(`Immutable prompt parameter: ${key}`);
    }
    if (current.purpose === "ANSWER" && allowedFields.some((key) => !(key in parameters))) throw new Error("Missing call prompt parameter");
    return this.db.transaction(() => {
      const active = this.db.prepare("SELECT version FROM prompts WHERE template_key=? AND active=1").get(current.template_key) as { version: number };
      if (active.version !== input.baseVersion) throw new PromptConflictError("Prompt changed; reload before saving");
      this.db.prepare("UPDATE prompts SET active=0 WHERE template_key=? AND active=1").run(current.template_key);
      const row = { ...current, id: randomUUID(), version: active.version + 1, system_template: input.system_template, user_template: input.user_template, parameters, created_at: new Date().toISOString() };
      this.db.prepare("INSERT INTO prompts(id,template_key,purpose,mode,variant,version,system_template,user_template,parameters_json,active,created_at) VALUES (?,?,?,?,?,?,?,?,?,1,?)").run(row.id, row.template_key, row.purpose, row.mode, row.variant, row.version, row.system_template, row.user_template, encoded, row.created_at);
      return row;
    })();
  }
}
export const promptRepository = new PromptRepository();