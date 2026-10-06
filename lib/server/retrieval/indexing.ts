import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { normalizeSearch } from "./normalization";

export function splitSearchChunks(text: string, maximum = 1600, overlap = 180): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + maximum);
    if (end < clean.length) {
      const segment = clean.slice(start, end);
      const boundaries = [...segment.matchAll(/[.!?](?:\s|$)|\n/g)];
      const boundary = boundaries.at(-1);
      if (boundary && boundary.index! > maximum * 0.6) end = start + boundary.index! + boundary[0].length;
      else {
        const space = segment.lastIndexOf(" ");
        if (space > maximum * 0.6) end = start + space;
      }
    }
    chunks.push(clean.slice(start, end).trim());
    if (end === clean.length) break;
    start = Math.max(start + 1, end - Math.min(overlap, Math.floor(maximum / 4)));
  }
  return chunks;
}

export function indexContent(database: Database.Database, owner: "entry_id" | "document_id" | "question_id" | "summary_session_id" | "transcript_turn_id", id: string, title: string, text: string): void {
  database.prepare(`DELETE FROM retrieval_items WHERE ${owner} = ?`).run(id);
  const chunks = splitSearchChunks(text);
  const insert = database.prepare(`INSERT INTO retrieval_items(${owner}, chunk_index, title, body, search_terms, token_estimate, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  chunks.forEach((chunk, position) => insert.run(id, position, title, chunk, normalizeSearch(`${title} ${chunk}`), Math.ceil(chunk.length / 4), crypto.createHash("sha256").update(chunk).digest("hex")));
}