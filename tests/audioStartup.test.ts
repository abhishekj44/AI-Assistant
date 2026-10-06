import assert from "node:assert/strict";
import test from "node:test";
import { AudioTransportService } from "../lib/audio/audioTransportService";

test("a rejected speech connection fails startup and releases microphone tracks instead of hanging", async context => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  class RejectedSocket {
    static OPEN = 1;
    readyState = 0;
    binaryType = "";
    onopen?: () => void;
    onmessage?: () => void;
    onerror?: () => void;
    onclose?: (event: { code: number }) => void;
    constructor() {
      queueMicrotask(() => { this.readyState = 3; this.onclose?.({ code: 1008 }); });
    }
    close() { this.readyState = 3; }
  }
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: RejectedSocket });
  context.mock.method(globalThis, "fetch", async () => Response.json({ accessToken: "temporary-test-token" }));
  context.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (previousSocket) Object.defineProperty(globalThis, "WebSocket", previousSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  });
  let stopped = false;
  const track = { stop: () => { stopped = true; } };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
  const service = new AudioTransportService("me", "Local interviewer microphone");
  const states: string[] = [];
  service.onStateChange(state => states.push(state));
  await assert.rejects(service.start(stream), /rejected \(1008\)/);
  assert.equal(stopped, true);
  assert.equal(service.getState(), "DISCONNECTED");
  assert.ok(!states.includes("RECONNECTING"));
});