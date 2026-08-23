import { transcriptStateMachine } from "@/lib/transcriptStateMachine";
import { getCombinedKeyterms } from "@/lib/audio/keyterms";
import type { SpeakerRole } from "@/lib/conversationTypes";

export type ConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "STREAMING" | "RECONNECTING" | "ERROR";
export type DeepgramModelChoice = "nova-3" | "flux";

export class AudioTransportError extends Error {
  readonly code?: string;
  readonly help?: string;

  constructor(message: string, code?: string, help?: string) {
    super(message);
    this.name = "AudioTransportError";
    this.code = code;
    this.help = help;
  }
}

export interface LatencyMetrics {
  captureToSendMs: number;
  sendToInterimMs: number;
  captureToFinalMs: number;
  lastCalculatedAt: number;
}

export class AudioTransportService {
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private mediaStream: MediaStream | null = null;
  private ws: WebSocket | null = null;
  private speaker: SpeakerRole;
  private label: string;

  private state: ConnectionState = "DISCONNECTED";
  private selectedModel: DeepgramModelChoice = "nova-3";
  private backgroundContext = "";
  private stateChangeListeners = new Set<(state: ConnectionState) => void>();
  private latencyListeners = new Set<(metrics: LatencyMetrics) => void>();
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastAudioSentTime = 0;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private isIntentionalStop = false;
  private readonly maxQueueSize = 150;
  private audioQueue: ArrayBuffer[] = [];
  private lastCaptureTime = 0;
  private lastSendTime = 0;

  constructor(speaker: SpeakerRole, label: string) {
    this.speaker = speaker;
    this.label = label;
  }

  setModel(model: DeepgramModelChoice) {
    this.selectedModel = model;
  }

  setBackgroundContext(bg: string) {
    this.backgroundContext = bg;
  }

  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateChangeListeners.add(listener);
    listener(this.state);
    return () => this.stateChangeListeners.delete(listener);
  }

  onLatencyUpdate(listener: (metrics: LatencyMetrics) => void): () => void {
    this.latencyListeners.add(listener);
    return () => this.latencyListeners.delete(listener);
  }

  getState(): ConnectionState {
    return this.state;
  }

  private setState(newState: ConnectionState) {
    this.state = newState;
    for (const listener of this.stateChangeListeners) {
      try { listener(newState); } catch (error) { console.error(`${this.label} state listener failed`, error); }
    }
  }

  async start(stream: MediaStream, customBg?: string, model: DeepgramModelChoice = "nova-3") {
    if (stream.getAudioTracks().length === 0) throw new Error(`${this.label}: audio stream has no audio track`);
    if (this.state !== "DISCONNECTED" && this.state !== "ERROR") await this.stop();

    this.isIntentionalStop = false;
    this.mediaStream = stream;
    this.reconnectAttempts = 0;
    this.selectedModel = model;
    if (customBg !== undefined) this.backgroundContext = customBg;

    try {
      this.setState("CONNECTING");
      const accessToken = await this.fetchEphemeralToken();
      await this.connectWebSocket(accessToken);
      await this.initAudioGraph(stream);
      this.setState("STREAMING");
      this.startKeepAlive();
    } catch (error) {
      console.error(`${this.label} audio start failed:`, error);
      this.setState("ERROR");
      await this.stop();
      throw error;
    }
  }

  private async fetchEphemeralToken(): Promise<string> {
    const response = await fetch("/api/deepgram", { cache: "no-store" });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.accessToken) {
      throw new AudioTransportError(
        payload?.error || "Failed to obtain a temporary Deepgram token",
        typeof payload?.code === "string" ? payload.code : "DEEPGRAM_TOKEN_GRANT_FAILED",
        typeof payload?.help === "string" ? payload.help : undefined,
      );
    }
    return payload.accessToken;
  }

  private async connectWebSocket(accessToken: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model: this.selectedModel,
        encoding: "linear16",
        sample_rate: "16000",
        channels: "1",
        punctuate: "true",
        smart_format: "true",
        interim_results: "true",
        endpointing: "350",
        utterance_end_ms: "1000",
      });

      for (const keyterm of getCombinedKeyterms(this.backgroundContext)) params.append("keyterm", keyterm);

      const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ["bearer", accessToken]);
      this.ws = ws;
      ws.binaryType = "arraybuffer";

      const connectionTimeout = window.setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          reject(new Error(`${this.label}: Deepgram connection timed out`));
        }
      }, 8_000);

      ws.onopen = () => {
        window.clearTimeout(connectionTimeout);
        this.setState("CONNECTED");
        this.flushAudioQueue();
        resolve();
      };
      ws.onmessage = (event) => this.handleWebSocketMessage(event.data);
      ws.onerror = (event) => console.error(`${this.label}: Deepgram WebSocket error`, event);
      ws.onclose = (event) => {
        window.clearTimeout(connectionTimeout);
        if (this.ws === ws) this.ws = null;
        if (!this.isIntentionalStop) {
          console.warn(`${this.label}: WebSocket closed (${event.code}); reconnecting`);
          void this.handleReconnect();
        } else {
          this.setState("DISCONNECTED");
        }
      };
    });
  }

  private async initAudioGraph(stream: MediaStream) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioContextClass({ latencyHint: "interactive" });
    if (this.audioContext.state === "suspended") await this.audioContext.resume();

    await this.audioContext.audioWorklet.addModule("/worklets/pcm-processor.js");
    const source = this.audioContext.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(this.audioContext, "pcm-processor");
    this.workletNode.port.onmessage = (event) => {
      if (event.data?.type !== "pcm_data" || !event.data?.buffer) return;
      this.lastCaptureTime = Date.now();
      this.sendAudioFrame(event.data.buffer);
    };

    source.connect(this.workletNode);
    const silence = this.audioContext.createGain();
    silence.gain.value = 0;
    this.workletNode.connect(silence);
    silence.connect(this.audioContext.destination);
  }

  private sendAudioFrame(buffer: ArrayBuffer) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.lastSendTime = Date.now();
      this.ws.send(buffer);
      this.lastAudioSentTime = this.lastSendTime;
      return;
    }
    if (this.audioQueue.length >= this.maxQueueSize) this.audioQueue.shift();
    this.audioQueue.push(buffer);
  }

  private flushAudioQueue() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    while (this.audioQueue.length > 0) {
      const chunk = this.audioQueue.shift();
      if (!chunk) continue;
      this.ws.send(chunk);
      this.lastAudioSentTime = Date.now();
    }
  }

  private handleWebSocketMessage(data: string | ArrayBuffer) {
    if (typeof data !== "string") return;
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === "Results") {
        const receiveTime = Date.now();
        const isFinal = Boolean(parsed.is_final);
        const speechFinal = Boolean(parsed.speech_final);
        if (this.lastCaptureTime > 0) {
          const metrics: LatencyMetrics = {
            captureToSendMs: Math.max(0, this.lastSendTime - this.lastCaptureTime),
            sendToInterimMs: !isFinal ? Math.max(0, receiveTime - this.lastSendTime) : 0,
            captureToFinalMs: speechFinal ? Math.max(0, receiveTime - this.lastCaptureTime) : 0,
            lastCalculatedAt: receiveTime,
          };
          for (const listener of this.latencyListeners) listener(metrics);
        }
        transcriptStateMachine.processTranscriptEvent(parsed, this.speaker);
      } else if (parsed.type === "UtteranceEnd") {
        transcriptStateMachine.finalizeCurrentUtterance(this.speaker);
      }
    } catch (error) {
      console.error(`${this.label}: failed to parse Deepgram message`, error);
    }
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastAudioSentTime <= 3_000 || this.ws?.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(JSON.stringify({ type: "KeepAlive" }));
        this.lastAudioSentTime = now;
      } catch (error) {
        console.warn(`${this.label}: Deepgram keepalive failed`, error);
      }
    }, 2_000);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private async handleReconnect() {
    if (this.isIntentionalStop || this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setState("ERROR");
      return;
    }

    this.reconnectAttempts += 1;
    this.setState("RECONNECTING");
    const delay = Math.min(700 * Math.pow(1.6, this.reconnectAttempts) + Math.random() * 300, 8_000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.isIntentionalStop) return;

    try {
      const token = await this.fetchEphemeralToken();
      await this.connectWebSocket(token);
      this.setState("STREAMING");
      this.reconnectAttempts = 0;
    } catch (error) {
      console.error(`${this.label}: reconnect failed`, error);
      void this.handleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.isIntentionalStop = true;
    this.stopKeepAlive();

    try { this.workletNode?.port.postMessage({ command: "stop" }); } catch {}

    const ws = this.ws;
    if (ws?.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "Finalize" }));
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "CloseStream" }));
          ws.close();
        }
      } catch (error) {
        console.warn(`${this.label}: graceful Deepgram close failed`, error);
      }
    }

    transcriptStateMachine.finalizeCurrentUtterance(this.speaker);

    if (this.audioContext && this.audioContext.state !== "closed") {
      try { await this.audioContext.close(); } catch {}
    }
    this.audioContext = null;
    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;
    this.ws = null;
    this.workletNode = null;
    this.audioQueue = [];
    this.setState("DISCONNECTED");
  }
}

export const interviewerAudioTransportService = new AudioTransportService("interviewer", "Interviewer audio");
export const candidateAudioTransportService = new AudioTransportService("me", "Candidate microphone");
