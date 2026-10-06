import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { PromptRepository } from "../lib/server/repositories/promptRepository";
import { getRuntimeCallPrompt } from "../lib/server/runtimePrompts";
import { buildAnswerPromptDetailed, buildAnswerSystemInstruction } from "../lib/promptBuilder";

test("active answer prompt versions change runtime wording without removing quality rules", (context) => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const prompts = new PromptRepository(database);
  const sessionInfo = { callType: "giving_interview" as const, company: "Example", details: "" };
  const seed = prompts.getActive("ANSWER", "INTERVIEWEE");
  const updated = prompts.update({ id: seed.id, baseVersion: seed.version, system_template: "Speak in concise technical examples.", user_template: "Finish with the trade-off." });
  const runtime = getRuntimeCallPrompt(sessionInfo, prompts);
  assert.equal(runtime.promptId, updated.id);
  const parts = buildAnswerPromptDetailed({ candidateContext: "Verified project", recentTurns: [], question: "Why SQLite?", sessionInfo, runtimeTemplate: runtime.template });
  const system = buildAnswerSystemInstruction(undefined, false, undefined, false, sessionInfo, runtime.template);
  assert.ok(parts.prompt.endsWith("Finish with the trade-off."));
  assert.ok(system.includes("Speak in concise technical examples."));
  assert.ok(system.includes("IMMUTABLE CORE QUALITY RULES"));
  assert.ok(system.includes("Never invent facts"));
});