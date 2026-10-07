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
  assert.equal(ended.summaryStatus, "NONE");
  assert.equal(ended.status, "ENDED");
  assert.equal(repository.restoreActive(), null);
  repository.start({ id: "session", ownerTabId: "tab" });
  repository.end("session", "tab");
  const covered = repository.claimSummary("session")!;
  assert.equal(covered, 2);
  repository.appendTurns("session", [turn("three")], "tab");
  repository.updateMemory("session", { ...EMPTY_MEETING_MEMORY, summary: "late" }, 3, "tab");
  assert.equal(repository.get("session")?.memory.summary, "new");
  assert.equal(repository.completeSummary("session", "summary of two turns", covered), true);
  const partial = repository.get("session")!;
  assert.equal(partial.summaryStatus, "READY");
  assert.ok(partial.summaryThroughSequence < partial.throughSequence);
  repository.updateSummary("session", "stale", 1);
  assert.equal(repository.get("session")?.summary, "summary of two turns");
  assert.equal(repository.get("session")?.endedAt, ended.endedAt);
  assert.equal(repository.get("session")?.status, "ENDED");
});

test("lease requires explicit takeover", context => {
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
  assert.equal(repository.get("session")?.status, "ENDED");
});

test("summary claims run once, failures wait for a manual retry, and a restart frees stuck claims", context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new SessionRepository(database);
  repository.start({ id: "session", ownerTabId: "tab" });
  repository.appendTurns("session", [turn("one"), turn("two")], "tab");
  assert.equal(repository.claimSummary("session", true), null);
  repository.end("session", "tab");
  assert.equal(repository.claimSummary("session"), 2);
  assert.equal(repository.get("session")?.summaryStatus, "PENDING");
  assert.equal(repository.claimSummary("session"), null);
  assert.equal(repository.claimSummary("session", true), null);
  repository.failSummary("session", "provider unavailable");
  assert.equal(repository.get("session")?.summaryStatus, "FAILED");
  assert.equal(repository.get("session")?.summaryError, "provider unavailable");
  assert.equal(repository.claimSummary("session"), null);
  assert.equal(repository.claimSummary("session", true), 2);
  assert.equal(repository.recoverInterruptedSummaries(), 1);
  assert.equal(repository.get("session")?.summaryStatus, "FAILED");
  assert.match(repository.get("session")!.summaryError!, /stopped before/);
  assert.equal(repository.recoverInterruptedSummaries(), 0);
  assert.equal(repository.claimSummary("session", true), 2);
  assert.equal(repository.completeSummary("session", "Done", 2), true);
  assert.equal(repository.completeSummary("session", "Unclaimed duplicate", 2), false);
  const done = repository.get("session")!;
  assert.equal(done.summary, "Done");
  assert.equal(done.summaryStatus, "READY");
  assert.equal(done.summaryError, undefined);
  assert.equal(repository.claimSummary("session"), null);
  assert.equal(repository.claimSummary("missing", true), null);
});

test("sessions without any turns are never summarized", context => {
  const database = openDatabase(":memory:");
  context.after(() => database.close());
  const repository = new SessionRepository(database);
  repository.start({ id: "empty", ownerTabId: "tab" });
  repository.end("empty", "tab");
  assert.equal(repository.claimSummary("empty", true), null);
  assert.equal(repository.get("empty")?.summaryStatus, "NONE");
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
  assert.equal(repository.get("import")?.summaryStatus, "NONE");
  repository.importSnapshot({ ...snapshot, id: "import-summary", summary: "Imported summary" });
  assert.equal(repository.get("import-summary")?.summary, "Imported summary");
  assert.equal(repository.get("import-summary")?.summaryStatus, "READY");
  repository.start({ id: "live", ownerTabId: "tab" });
  assert.throws(() => repository.importSnapshot({ ...snapshot, id: "live" }), /live-owned/);
});