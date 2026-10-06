import assert from "node:assert/strict";
import test from "node:test";
import { microphonePolicy, startScopedCapture } from "../lib/audio/capturePolicy";
import type { SessionInfo } from "../lib/conversationTypes";

const taking: SessionInfo = { company: "", details: "", callType: "taking_interview", candidateProfile: "Backend engineer" };

function harness(deny = false, failLocal = false) {
  const events: string[] = [];
  const stream = (name: string) => {
    const track = { stop: () => events.push(`stop ${name}`) };
    return { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  };
  return { events, dependencies: {
    getDisplay: async () => stream("display"),
    getMicrophone: async () => { events.push("request mic"); if (deny) throw new Error("Permission denied"); return stream("mic"); },
    startRemote: async () => { events.push("remote connected"); },
    startLocal: async () => { events.push("local connected"); if (failLocal) throw new Error("STT failed"); },
    stopRemote: async () => { events.push("stop remote"); },
    stopLocal: async () => { events.push("stop local"); },
    startSession: () => { events.push("session started"); },
    endSession: async () => { events.push("session ended"); },
  } };
}

test("Taking requires mic independently of a false saved preference and starts after both captures", async () => {
  assert.deepEqual(microphonePolicy(taking, false), { required: true, capture: true });
  const { events, dependencies } = harness();
  await startScopedCapture(taking, false, dependencies);
  assert.deepEqual(events, ["request mic", "session started", "remote connected", "local connected"]);
});

test("Denied mic fails Taking and cleans up without creating a session", async () => {
  const { events, dependencies } = harness(true);
  await assert.rejects(startScopedCapture(taking, false, dependencies), /requires microphone permission/);
  assert.ok(events.includes("stop display"));
  assert.ok(events.includes("stop remote"));
  assert.ok(events.includes("stop local"));
  assert.ok(!events.includes("session started"));
});

test("Denied optional mic preserves remote capture for other modes", async () => {
  const { events, dependencies } = harness(true);
  const result = await startScopedCapture({ ...taking, callType: "meeting" }, true, dependencies);
  assert.match(result.warning, /remote audio only/);
  assert.ok(events.includes("session started"));
  assert.ok(!events.includes("stop display"));
});

test("Taking microphone STT failure cleans every track and both transports", async () => {
  const { events, dependencies } = harness(false, true);
  await assert.rejects(startScopedCapture(taking, false, dependencies), /requires microphone transcription/);
  for (const event of ["stop display", "stop mic", "stop remote", "stop local"]) assert.ok(events.includes(event));
  assert.ok(events.includes("session ended"));
});

test("Empty microphone fails Taking before session start and releases the returned stream", async () => {
  const { events, dependencies } = harness();
  dependencies.getMicrophone = async () => ({ getAudioTracks: () => [], getTracks: () => [{ stop: () => events.push("stop empty mic") }] } as unknown as MediaStream);
  await assert.rejects(startScopedCapture(taking, false, dependencies), /No microphone audio track/);
  assert.ok(events.includes("stop empty mic"));
  assert.ok(events.includes("stop display"));
  assert.ok(!events.includes("session started"));
});

test("Session start failure cleans captures, transports and a partially started session", async () => {
  const { events, dependencies } = harness();
  dependencies.startSession = () => { throw new Error("Session start failed"); };
  await assert.rejects(startScopedCapture(taking, false, dependencies), /Session start failed/);
  for (const event of ["stop display", "stop mic", "stop remote", "stop local", "session ended"]) assert.ok(events.includes(event));
});

test("Other modes with mic preference false never request microphone permission", async () => {
  const { events, dependencies } = harness();
  await startScopedCapture({ ...taking, callType: "giving_interview", jobDescription: "Backend role" }, false, dependencies);
  assert.ok(!events.includes("request mic"));
  assert.ok(events.includes("remote connected"));
});

test("Optional microphone STT failure releases local capture but preserves the remote session", async () => {
  const { events, dependencies } = harness(false, true);
  const result = await startScopedCapture({ ...taking, callType: "meeting" }, true, dependencies);
  assert.match(result.warning, /remote audio only/);
  assert.equal(result.microphone, undefined);
  assert.ok(events.includes("stop mic"));
  assert.ok(events.includes("stop local"));
  assert.ok(!events.includes("stop remote"));
  assert.ok(!events.includes("session ended"));
});