import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { QuestionBundle } from "@/lib/question/questionBundle";
import { getDatabase } from "../db/connection";
import { indexContent } from "../retrieval/indexing";

export type SessionMode = "INTERVIEWER" | "INTERVIEWEE" | "MEETING";

export interface StoredQuestionInput {
  id?: string;
  sessionId?: string;
  mode?: SessionMode;
  question: string;
  bundle?: QuestionBundle | null;
  createdAt?: string;
}

export class QuestionRepository {
  constructor(private readonly database: Database.Database = getDatabase()) {}

  create(input: StoredQuestionInput): string {
    if (!input.question.trim()) throw new Error("Question text is required");
    const id = input.id || crypto.randomUUID();
    this.database.prepare(`
      INSERT INTO questions(id, session_id, mode_snapshot, primary_ask, scenario_context, retrieval_query, bundle_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.sessionId || null, input.mode || null, input.question.trim(),
      input.bundle?.scenarioContext || "", input.bundle?.retrievalQuery || input.question.trim(),
      JSON.stringify(input.bundle || {}), input.createdAt || new Date().toISOString());
    indexContent(this.database, "question_id", id, input.question.trim(), [input.question, input.bundle?.scenarioContext].filter(Boolean).join("\n"));
    return id;
  }
}