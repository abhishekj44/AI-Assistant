import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptStateMachine } from "../lib/transcriptStateMachine";

test("restored finalized transcripts notify views without saving or duplicating turns", () => {
  const machine = new TranscriptStateMachine();
  let saves = 0;
  machine.onUtteranceCompleted(() => { saves += 1; });
  const turn = { id: "saved", sequenceId: 12, speaker: "interviewer" as const, text: "Why SQLite?", timestamp: new Date().toISOString() };
  machine.restore([turn, turn]);
  assert.equal(saves, 0);
  assert.equal(machine.getRecentFinalizedTurns().length, 1);
  assert.equal(machine.getLatestSequenceId(), 12);
  assert.equal(machine.getLatestQuestionBundle()?.primaryAsk, "Why SQLite?");
  machine.processTranscriptEvent({ channel: { alternatives: [{ transcript: "New turn" }] }, is_final: true, speech_final: true }, "interviewer");
  assert.equal(machine.getLatestSequenceId(), 13);
  assert.equal(saves, 1);
});