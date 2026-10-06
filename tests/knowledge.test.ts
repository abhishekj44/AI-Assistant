import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { KnowledgeRepository } from "../lib/server/repositories/knowledgeRepository";
import { EMPTY_KNOWLEDGE_PACK } from "../lib/knowledge/types";
import type { KnowledgeSource } from "../lib/knowledge/types";

test("knowledge baseline preserves refined imports and migration timestamps", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new KnowledgeRepository(database);
  const pack = { ...structuredClone(EMPTY_KNOWLEDGE_PACK), facts: ["Refined imported fact"], extra: { raw: true } };
  repository.replacePack(pack, undefined, true);
  assert.deepEqual(repository.getPack(), pack);
});

test("source replacement and deletion retain independent facts and cascade stale search", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new KnowledgeRepository(database);
  const source: KnowledgeSource = { id: "source", filename: "resume.txt", type: "resume", uploadedAt: "2020-01-01", summary: "Legacy zebra", facts: ["zebra"], keywords: [], contribution: { skills: ["C++"] } };
  repository.replacePack({ ...structuredClone(EMPTY_KNOWLEDGE_PACK), facts: ["Independent", "zebra"], skills: ["C++"], sources: [source] });
  repository.addSource({ ...source, id: "new", facts: ["New otter"], contribution: { skills: ["C#"] } }, undefined, { bytes: Buffer.from("original"), text: "Full unabridged source", mimeType: "text/plain" });
  assert.deepEqual(repository.getPack().facts, ["New otter", "Independent"]);
  assert.deepEqual(repository.getPack().skills, ["C#"]);
  const document = database.prepare("SELECT original_bytes, extracted_text FROM knowledge_documents").get() as { original_bytes: Buffer; extracted_text: string };
  assert.equal(document.original_bytes.toString(), "original");
  assert.equal(document.extracted_text, "Full unabridged source");
  repository.replacePack(repository.getPack());
  assert.equal((database.prepare("SELECT original_bytes FROM knowledge_documents").get() as { original_bytes: Buffer }).original_bytes.toString(), "original");
  repository.deleteSource("new");
  assert.deepEqual(repository.getPack().facts, ["Independent"]);
  assert.equal(database.prepare<[], { count: number }>("SELECT count(*) AS count FROM retrieval_fts WHERE retrieval_fts MATCH 'otter'").get()!.count, 0);
  database.exec("INSERT INTO retrieval_fts(retrieval_fts, rank) VALUES ('integrity-check', 1)");
});

test("refined project extras survive source removal and raw import remains available", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new KnowledgeRepository(database);
  const project = { name: "Engine", technologies: ["C++"], decisions: [], challenges: [], metrics: [], lessons: [] };
  const source: KnowledgeSource = { id: "src", filename: "project.txt", type: "project", uploadedAt: "2020", summary: "", facts: [], keywords: [], contribution: { projects: [project] } };
  const pack = { ...structuredClone(EMPTY_KNOWLEDGE_PACK), projects: [{ ...project, metrics: ["Refined metric"], examples: [{ title: "Source-supported example", result: "Improvement" }] }], sources: [source], rawExtras: { lossless: true } };
  repository.replacePack(pack, undefined, true);
  const deleted = repository.deleteSource("src");
  assert.deepEqual(deleted.projects[0].metrics, ["Refined metric"]);
  assert.deepEqual(deleted.projects[0].technologies, []);
  assert.equal(deleted.projects[0].examples![0].title, "Source-supported example");
  const stored = JSON.parse((database.prepare("SELECT baseline_json FROM knowledge_bases WHERE id = 'personal-knowledge'").get() as { baseline_json: string }).baseline_json);
  assert.deepEqual(stored.importedPack, pack);
  assert.equal(database.prepare<[], { count: number }>("SELECT count(*) AS count FROM knowledge_documents").get()!.count, 0);
});

test("uploading a revised personal resume replaces the old filename without clearing Q&A or notes", context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new KnowledgeRepository(database);
  const source: KnowledgeSource = { id: "old-resume", filename: "old-resume.txt", type: "resume", uploadedAt: "2020", summary: "", facts: ["Old resume detail"], keywords: [] };
  repository.addSource(source);
  repository.addSource({ ...source, id: "notes", filename: "project.txt", type: "project", facts: ["Project note"] });
  repository.addSource({ ...source, id: "new-resume", filename: "updated-resume.pdf", facts: ["Current resume detail"] });
  const pack = repository.getPack();
  assert.deepEqual(pack.sources.filter(item => item.type === "resume").map(item => item.id), ["new-resume"]);
  assert.ok(pack.facts.includes("Project note"));
  assert.ok(pack.facts.includes("Current resume detail"));
  assert.ok(!pack.facts.includes("Old resume detail"));
});