/**
 * Production Audio Transport Service
 * 
 * Handles:
 * 1. AudioWorklet (pcm-processor.js) capture on Web Audio thread -> Linear16 16kHz PCM
 * 2. Dedicated WebSocket streaming directly to Deepgram Nova-3 (outside React render loop)
 * 3. KeepAlive heartbeat (3s silence interval)
 * 4. Bounded audio buffering with backpressure
 * 5. Reconnection with exponential backoff & jitter
 * 6. Graceful teardown (Finalize -> Wait -> CloseStream)
 * 7. Real-time latency instrumentation
 */

import { transcriptStateMachine } from "@/lib/transcriptStateMachine";
import { getCombinedKeyterms } from "@/lib/audio/keyterms";

export type ConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "STREAMING" | "RECONNECTING" | "ERROR";
export type DeepgramModelChoice = "nova-3" | "flux";

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

  private state: ConnectionState = "DISCONNECTED";
  private selectedModel: DeepgramModelChoice = "nova-3";
  private backgroundContext: string = "";
  private stateChangeListeners: Set<(state: ConnectionState) => void> = new Set();
  private latencyListeners: Set<(metrics: LatencyMetrics) => void> = new Set();

  private keepAliveTimer: any = null;
  private lastAudioSentTime: number = 0;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 5;
  private isIntentionalStop: boolean = false;

  // Bounded audio queue (max 5 seconds of 32ms frames = ~150 frames)
  private maxQueueSize: number = 150;
  private audioQueue: ArrayBuffer[] = [];

  // Latency tracking
  private lastCaptureTime: number = 0;
  private lastSendTime: number = 0;

  constructor() {
    this.setState("DISCONNECTED");
  }

  /**
   * Set model choice (nova-3 or flux)
   */
  setModel(model: DeepgramModelChoice) {
    this.selectedModel = model;
  }

  /**
   * Set background context for keyterm extraction
   */
  setBackgroundContext(bg: string) {
    this.backgroundContext = bg;
  }

  /**
   * Subscribe to connection state changes
   */
  onStateChange(listener: (state: ConnectionState) => void): () => void {
    this.stateChangeListeners.add(listener);
    listener(this.state);
    return () => this.stateChangeListeners.delete(listener);
  }

  /**
   * Subscribe to latency telemetry
   */
  onLatencyUpdate(listener: (metrics: LatencyMetrics) => void): () => void {
    this.latencyListeners.add(listener);
    return () => this.latencyListeners.delete(listener);
  }

  public getState(): ConnectionState {
    return this.state;
  }

  private setState(newState: ConnectionState) {
    this.state = newState;
    this.stateChangeListeners.forEach((fn) => {
      try {
        fn(newState);
      } catch (e) {
        console.error("State listener error:", e);
      }
    });
  }

  /**
   * Start audio capture and WebSocket streaming
   */
  async start(
    stream: MediaStream,
    speaker: 'user' | 'system' | 'external' = 'external',
    customBg?: string,
    model: DeepgramModelChoice = "nova-3"
  ) {
    this.isIntentionalStop = false;
    this.mediaStream = stream;
    this.reconnectAttempts = 0;
    this.selectedModel = model;
    if (customBg) this.backgroundContext = customBg;

    try {
      this.setState("CONNECTING");

      // 1. Fetch short-lived token from backend
      const tokenResponse = await fetch("/api/deepgram");
      const tokenData = await tokenResponse.json();
      const apiKey = tokenData.key;

      if (!apiKey) {
        throw new Error("Failed to obtain ephemeral Deepgram token");
      }

      // 2. Establish Deepgram WebSocket with Keyterms
      await this.connectWebSocket(apiKey, speaker);

      // 3. Initialize Web Audio graph & AudioWorklet
      await this.initAudioGraph(stream);

      this.setState("STREAMING");
      this.startKeepAlive();
    } catch (error) {
      console.error("AudioTransportService start error:", error);
      this.setState("ERROR");
      await this.stop();
      throw error;
    }
  }

  private async connectWebSocket(apiKey: string, speaker: 'user' | 'system' | 'external'): Promise<void> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        model: this.selectedModel || "nova-3",
        encoding: "linear16",
        sample_rate: "16000",
        channels: "1",
        punctuate: "true",
        smart_format: "true",
        interim_results: "true",
        endpointing: "350",
        utterance_end_ms: "1000",
      });

      // Keyterm prompting for Nova-3 (passed as 'keyterm' parameter)
      const keyterms = getCombinedKeyterms(this.backgroundContext);
      keyterms.forEach((kt) => {
        params.append("keyterm", kt);
      });

      const wsUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
      this.ws = new WebSocket(wsUrl, ["token", apiKey]);
      this.ws.binaryType = "arraybuffer";

      const connectionTimeout = setTimeout(() => {
        if (this.ws && this.ws.readyState !== WebSocket.OPEN) {
          this.ws.close();
          reject(new Error("Deepgram WebSocket connection timed out"));
        }
      }, 8000);

      this.ws.onopen = () => {
        clearTimeout(connectionTimeout);
        this.setState("CONNECTED");
        this.flushAudioQueue();
        resolve();
      };

      this.ws.onmessage = (event) => {
        this.handleWebSocketMessage(event.data, speaker);
      };

      this.ws.onerror = (error) => {
        console.error("Deepgram WebSocket error:", error);
      };

      this.ws.onclose = (event) => {
        clearTimeout(connectionTimeout);
        if (!this.isIntentionalStop) {
          console.warn(`WebSocket closed unexpectedly (code: ${event.code}). Attempting reconnect...`);
          this.handleReconnect(speaker);
        } else {
          this.setState("DISCONNECTED");
        }
      };
    });
  }

  private async initAudioGraph(stream: MediaStream) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    this.audioContext = new AudioContextClass({ latencyHint: "interactive" });

    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    // Load AudioWorklet downsampler processor
    await this.audioContext.audioWorklet.addModule("/worklets/pcm-processor.js");

    const source = this.audioContext.createMediaStreamSource(stream);
    this.workletNode = new AudioWorkletNode(this.audioContext, "pcm-processor");

    this.workletNode.port.onmessage = (event) => {
      if (event.data?.type === "pcm_data" && event.data?.buffer) {
        this.lastCaptureTime = Date.now();
        this.sendAudioFrame(event.data.buffer);
      }
    };

    source.connect(this.workletNode);
    // Silent output to keep graph processing
    const silence = this.audioContext.createGain();
    silence.gain.value = 0;
    this.workletNode.connect(silence);
    silence.connect(this.audioContext.destination);
  }

  /**
   * Send binary PCM frame to WebSocket with backpressure
   */
  private sendAudioFrame(buffer: ArrayBuffer) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.lastSendTime = Date.now();
      this.ws.send(buffer);
      this.lastAudioSentTime = this.lastSendTime;
    } else {
      // Bounded queue: drop oldest if buffer exceeds limit
      if (this.audioQueue.length >= this.maxQueueSize) {
        this.audioQueue.shift();
      }
      this.audioQueue.push(buffer);
    }
  }

  private flushAudioQueue() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.audioQueue.length > 0) {
      const chunk = this.audioQueue.shift();
      if (chunk) {
        this.ws.send(chunk);
        this.lastAudioSentTime = Date.now();
      }
    }
  }

  private handleWebSocketMessage(data: string | ArrayBuffer, speaker: 'user' | 'system' | 'external') {
    if (typeof data !== "string") return;

    try {
      const parsed = JSON.parse(data);

      if (parsed.type === "Results") {
        const receiveTime = Date.now();
        const isFinal = Boolean(parsed.is_final);
        const speechFinal = Boolean(parsed.speech_final);

        // Latency telemetry
        if (this.lastCaptureTime > 0) {
          const metrics: LatencyMetrics = {
            captureToSendMs: Math.max(0, this.lastSendTime - this.lastCaptureTime),
            sendToInterimMs: !isFinal ? Math.max(0, receiveTime - this.lastSendTime) : 0,
            captureToFinalMs: speechFinal ? Math.max(0, receiveTime - this.lastCaptureTime) : 0,
            lastCalculatedAt: receiveTime,
          };
          this.latencyListeners.forEach((fn) => fn(metrics));
        }

        // Feed to transcript state machine
        transcriptStateMachine.processTranscriptEvent(parsed, speaker);
      } else if (parsed.type === "UtteranceEnd") {
        transcriptStateMachine.finalizeCurrentUtterance();
      }
    } catch (e) {
      console.error("Error parsing Deepgram message:", e);
    }
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      const now = Date.now();
      // If no audio frame sent in last 3000ms, send KeepAlive JSON
      if (now - this.lastAudioSentTime > 3000 && this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: "KeepAlive" }));
          this.lastAudioSentTime = now;
        } catch (e) {
          console.warn("Failed to send Deepgram KeepAlive:", e);
        }
      }
    }, 2000);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private async handleReconnect(speaker: 'user' | 'system' | 'external') {
    if (this.isIntentionalStop || this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setState("ERROR");
      return;
    }

    this.reconnectAttempts++;
    this.setState("RECONNECTING");

    // Exponential backoff + jitter
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts) + Math.random() * 500, 10000);
    console.log(`Reconnecting to Deepgram in ${Math.round(delay)}ms (Attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(async () => {
      try {
        const tokenRes = await fetch("/api/deepgram");
        const tokenData = await tokenRes.json();
        if (tokenData.key) {
          await this.connectWebSocket(tokenData.key, speaker);
          this.setState("STREAMING");
          this.reconnectAttempts = 0;
        }
      } catch (err) {
        console.error("Reconnect failed:", err);
        this.handleReconnect(speaker);
      }
    }, delay);
  }

  /**
   * Graceful Stop / Teardown
   * 1. Flush remaining audio
   * 2. Send Deepgram 'Finalize'
   * 3. Await remaining transcripts
   * 4. Send Deepgram 'CloseStream'
   * 5. Stop media tracks & AudioContext
   */
  async stop(): Promise<void> {
    this.isIntentionalStop = true;
    this.stopKeepAlive();

    // 1. Tell worklet to stop recording and flush remaining samples
    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ command: "stop" });
      } catch (e) {}
    }

    // 2. Send Finalize to Deepgram to process any tail frames
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "Finalize" }));
        // Give Deepgram 300ms to return remaining final transcripts
        await new Promise((resolve) => setTimeout(resolve, 300));
        this.ws.send(JSON.stringify({ type: "CloseStream" }));
        this.ws.close();
      } catch (e) {
        console.warn("Error during graceful Deepgram close:", e);
      }
    }

    // 3. Finalize in-flight state in state machine
    transcriptStateMachine.finalizeCurrentUtterance();

    // 4. Close audio graph & media tracks
    if (this.audioContext && this.audioContext.state !== "closed") {
      try {
        await this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.ws = null;
    this.workletNode = null;
    this.audioQueue = [];
    this.setState("DISCONNECTED");
  }
}

export const audioTransportService = new AudioTransportService();
