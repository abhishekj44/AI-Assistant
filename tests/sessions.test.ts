import assert from "node:assert/strict";
import test from "node:test";
import { openDatabase } from "../lib/server/db/connection";
import { SessionRepository } from "../lib/server/repositories/sessionRepository";
import { EMPTY_MEETING_MEMORY, type SessionInfo, type TranscriptTurn } from "../lib/conversationTypes";

const info: SessionInfo = { company: "Example", callType: "taking_interview", details: "Role", modeVariant: "course_admission" };
const turn = (id: string, sequenceId = 99): TranscriptTurn => ({ id, sequenceId, speaker: "me", text: `Text ${id}`, timestamp: new Date().toISOString() });

test("start validates modes, preserves variant and locks mode after turns", context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new SessionRepository(database);
  for (const callType of ["taking_interview", "giving_interview", "meeting"] as const) {
    assert.equal(repository.start({ id: callType, ownerTabId: "tab", sessionInfo: { ...info, callType } }).sessionInfo?.callType, callType);
  }
  assert.throws(() => repository.start({ id: "bad", ownerTabId: "tab", sessionInfo: { ...info, callType: "wrong" as SessionInfo["callType"] } }), /Invalid session mode/);
  assert.equal(repository.get("taking_interview")?.sessionInfo?.modeVariant, "course_admission");
  repository.appendTurns("taking_interview", [turn("first")], "tab");
  assert.throws(() => repository.start({ id: "taking_interview", ownerTabId: "tab", sessionInfo: { ...info, callType: "meeting" } }), /locked/);
});

test("turn retries increment once, preserve legacy metadata and retain full transcripts", context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new SessionRepository(database);
  repository.start({ id: "session", ownerTabId: "tab" });
  const turns = Array.from({ length: 650 }, (_, index) => turn(`turn-${index}`));
  repository.appendTurns("session", turns, "tab");
  const saved = repository.appendTurns("session", [turn("turn-1"), turn("last")], "tab");
  assert.equal(saved.transcripts.length, 651);
  assert.equal(saved.throughSequence, 651);
  assert.deepEqual(saved.transcripts.slice(-2).map(value => value.sequenceId), [650, 651]);
  assert.equal(JSON.parse((database.prepare("SELECT metadata_json FROM transcript_turns WHERE client_turn_id='last'").get() as { metadata_json: string }).metadata_json).sequenceId, 99);
  assert.equal(repository.list()[0].transcripts.length, 0);
  assert.equal(repository.list({ includeTranscripts: true })[0].transcripts.length, 651);
});

test("end commits before summary, late batches never reopen and stale memory cannot overwrite", context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new SessionRepository(database);
  repository.start({ id: "session", ownerTabId: "tab" });
  repository.appendTurns("session", [turn("one"), turn("two")], "tab");
  repository.updateMemory("session", { ...EMPTY_MEETING_MEMORY, summary: "new" }, 2, "tab");
  repository.updateMemory("session", { ...EMPTY_MEETING_MEMORY, summary: "old" }, 1, "tab");
  assert.equal(repository.get("session")?.memory.summary, "new");
  const ended = repository.end("session", "tab");
  assert.equal(ended.summaryStatus, "PENDING");
  assert.equal(ended.status, "ENDED");
  assert.equal(repository.restoreActive(), null);
  repository.start({ id: "session", ownerTabId: "tab" });
  repository.end("session", "tab");
  const oldJob = repository.claimJob()!;
  repository.appendTurns("session", [turn("three")], "tab");
  repository.updateMemory("session", { ...EMPTY_MEETING_MEMORY, summary: "late" }, 3, "tab");
  assert.equal(repository.get("session")?.memory.summary, "new");
  repository.completeJob(oldJob, "old summary");
  assert.equal(repository.get("session")?.summaryStatus, "PENDING");
  repository.completeJob(repository.claimJob()!, "new summary");
  repository.updateSummary("session", "stale", 2);
  assert.equal(repository.get("session")?.summary, "new summary");
  assert.equal(repository.get("session")?.endedAt, ended.endedAt);
  assert.equal(repository.get("session")?.status, "ENDED");
});

test("lease requires explicit takeover and expired jobs can be reclaimed", context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new SessionRepository(database);
  repository.start({ id: "session", ownerTabId: "one" });
  assert.throws(() => repository.start({ id: "session", ownerTabId: "two", takeover: true }), /lease/);
  database.prepare("UPDATE sessions SET lease_expires_at=0 WHERE id='session'").run();
  assert.throws(() => repository.start({ id: "session", ownerTabId: "two" }), /lease/);
  repository.start({ id: "session", ownerTabId: "two", takeover: true });
  assert.throws(() => repository.appendTurns("session", [turn("one")], "one"), /another tab/);
  repository.end("session", "two", [turn("last")]);
  const first = repository.claimJob()!;
  database.prepare("UPDATE background_jobs SET locked_until=0 WHERE id=?").run(first.id);
  const reclaimed = repository.claimJob()!;
  assert.equal(reclaimed.attempts, 2);
  repository.completeJob(first, "stale worker");
  assert.equal(repository.get("session")?.summaryStatus, "PENDING");
  repository.failJob(reclaimed, "provider unavailable");
  assert.equal(repository.claimJob(), null);
});

test("legacy import is idempotent and cannot bypass live ownership", context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new SessionRepository(database);
  const snapshot = { id: "import", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), sessionInfo: info, memory: { ...EMPTY_MEETING_MEMORY, summary: "legacy" }, transcripts: [turn("old")] };
  repository.importSnapshot(snapshot);
  repository.importSnapshot(snapshot);
  assert.equal(repository.get("import")?.transcripts.length, 1);
  assert.equal(repository.get("import")?.memory.summary, "legacy");
  repository.start({ id: "live", ownerTabId: "tab" });
  assert.throws(() => repository.importSnapshot({ ...snapshot, id: "live" }), /live-owned/);
});