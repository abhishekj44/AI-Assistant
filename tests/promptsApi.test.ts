import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { PromptRepository, promptRepository } from "../lib/server/repositories/promptRepository";
import { GET, PUT } from "../app/api/prompts/route";

test("prompt HTTP API selects active variants and reports stale-version conflicts", async (context) => {
  const db = openDatabase(":memory:");
  context.after(() => db.close());
  const repo = new PromptRepository(db);
  context.mock.method(promptRepository, "list", repo.list.bind(repo));
  context.mock.method(promptRepository, "getActive", repo.getActive.bind(repo));
  context.mock.method(promptRepository, "update", repo.update.bind(repo));
  const response = await GET(new Request("http://localhost/api/prompts?purpose=ANSWER&mode=INTERVIEWER&variant=course_admission"));
  assert.equal(response.status, 200);
  const { template } = await response.json();
  assert.equal(template.variant, "course_admission");
  const save = (patch: object) => PUT(new Request("http://localhost/api/prompts", { method: "PUT", body: JSON.stringify({ id: template.id, baseVersion: 1, system_template: "Changed", user_template: "{{question}}", ...patch }) }));
  assert.equal((await save({})).status, 200);
  assert.equal((await save({})).status, 409);
  assert.equal((await save({ key: template.template_key, baseVersion: 2, mode: "MEETING" })).status, 400);
  assert.equal((await GET(new Request("http://localhost/api/prompts?purpose=CHAT&mode=INTERVIEWER"))).status, 400);
  const reset = await save({ key: template.template_key, baseVersion: 2, reset: true });
  assert.equal(reset.status, 200);
  assert.equal((await reset.json()).template.version, 3);
});