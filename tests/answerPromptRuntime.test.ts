import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { PromptRepository } from "../lib/server/repositories/promptRepository";
import { getRuntimeCallPrompt } from "../lib/server/runtimePrompts";
import { buildAnswerPromptDetailed, buildAnswerSystemInstruction } from "../lib/promptBuilder";

test("a saved answer prompt changes runtime wording without removing quality rules", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const prompts = new PromptRepository(database);
  const sessionInfo = { callType: "giving_interview" as const, company: "Example", details: "Architecture round",
    jobTitle: "Backend Engineer", jobDescription: "Reliable storage systems", seniority: "Junior" };
  const seed = prompts.get("ANSWER", "INTERVIEWEE");
  prompts.update({ key: seed.template_key, system_template: "Speak in concise technical examples.", user_template: "Finish with the trade-off." });
  const runtime = getRuntimeCallPrompt(sessionInfo, prompts);
  assert.equal(runtime.promptKey, seed.template_key);
  assert.equal(runtime.promptCustomized, true);
  const parts = buildAnswerPromptDetailed({ candidateContext: "Verified project", recentTurns: [], question: "Why SQLite?", sessionInfo, runtimeTemplate: runtime.template });
  const system = buildAnswerSystemInstruction(undefined, false, undefined, false, sessionInfo, runtime.template);
  assert.ok(parts.prompt.endsWith("Finish with the trade-off."));
  assert.ok(system.includes("Speak in concise technical examples."));
  assert.ok(system.includes("IMMUTABLE CORE QUALITY RULES"));
  assert.ok(system.includes("Never invent facts"));
  assert.ok(system.includes("Use the job description to understand expected role, skills and seniority."));
  assert.ok(system.includes("Do not assume every question will relate directly to the job description."));
  assert.ok(system.includes("Always answer the actual question asked."));
  assert.ok(system.includes("strongly tailor the answer's relevant skills"));
  assert.ok(system.includes("answer normally using relevant knowledge-base evidence and general knowledge"));
  assert.equal(JSON.parse(parts.sessionContextText).seniority, "Junior");
});

test("default Giving Interview depth follows the supplied seniority instead of forcing senior level", context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const prompts = new PromptRepository(database);
  const sessionInfo = { callType: "giving_interview" as const, company: "", details: "", seniority: "Entry-level" };
  const runtime = getRuntimeCallPrompt(sessionInfo, prompts);
  const system = buildAnswerSystemInstruction(undefined, false, undefined, false, sessionInfo, runtime.template);
  assert.ok(system.includes("Match depth to the stated seniority when supplied"));
  assert.ok(system.includes("Use the stated seniority to calibrate depth, not to change the subject"));
  assert.ok(!system.includes("Communicate at senior-engineer/professional depth"));
});