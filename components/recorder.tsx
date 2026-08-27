"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { MicIcon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { Activity, MicOffIcon, UserRound, Volume2, Zap } from "lucide-react";
import { sessionManager } from "@/lib/sessionManager";
import { transcriptStateMachine } from "@/lib/transcriptStateMachine";
import type { SessionInfo } from "@/lib/conversationTypes";
import { SessionInfoModal } from "@/components/SessionInfoModal";
import {
  AudioTransportError,
  candidateAudioTransportService,
  interviewerAudioTransportService,
  type ConnectionState,
  type LatencyMetrics,
} from "@/lib/audio/audioTransportService";

const CAPTURE_MIC_STORAGE_KEY = "meetingCopilot.captureCandidateMic";

function isMicrophonePermissionError(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  return error.name === "NotAllowedError" || error.name === "PermissionDeniedError" || error.name === "SecurityError";
}

function describeAudioStartError(error: unknown): string {
  if (error instanceof AudioTransportError) {
    if (error.code === "DEEPGRAM_INSUFFICIENT_PERMISSIONS") {
      return "Deepgram authentication failed: the configured API key cannot mint temporary browser tokens. Create a Deepgram API key with Member-or-higher permission and update DEEPGRAM_API_KEY. This is unrelated to microphone permission.";
    }
    return error.help ? `${error.message} ${error.help}` : error.message;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Unable to start audio transcription";
}

export default function RecorderTranscriber() {
  const [interviewerState, setInterviewerState] = useState<ConnectionState>("DISCONNECTED");
  const [candidateState, setCandidateState] = useState<ConnectionState>("DISCONNECTED");
  const [latencyMetrics, setLatencyMetrics] = useState<LatencyMetrics | null>(null);
  const [screenVideoStream, setScreenVideoStream] = useState<MediaStream | null>(null);
  const [isPreviewMinimized, setIsPreviewMinimized] = useState(false);
  const [captureCandidateMic, setCaptureCandidateMic] = useState(false);
  const [warning, setWarning] = useState<string>("");
  const [sessionModalOpen, setSessionModalOpen] = useState(false);
  const pendingSessionInfoRef = useRef<SessionInfo | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stoppingRef = useRef(false);

  useEffect(() => {
    const unsubInterviewer = interviewerAudioTransportService.onStateChange(setInterviewerState);
    const unsubCandidate = candidateAudioTransportService.onStateChange(setCandidateState);
    const unsubLatency = interviewerAudioTransportService.onLatencyUpdate(setLatencyMetrics);
    return () => { unsubInterviewer(); unsubCandidate(); unsubLatency(); };
  }, []);

  useEffect(() => {
    try {
      setCaptureCandidateMic(localStorage.getItem(CAPTURE_MIC_STORAGE_KEY) === "true");
    } catch {
      // Storage can be unavailable in private/restricted browser contexts.
    }
  }, []);

  useEffect(() => {
    if (!screenVideoStream || !videoRef.current) return;
    videoRef.current.srcObject = screenVideoStream;
    void videoRef.current.play().catch(() => undefined);
  }, [screenVideoStream]);

  const updateCaptureCandidateMic = useCallback((enabled: boolean) => {
    setCaptureCandidateMic(enabled);
    try {
      localStorage.setItem(CAPTURE_MIC_STORAGE_KEY, String(enabled));
    } catch {
      // The preference is optional; never block transcription on localStorage.
    }
  }, []);

  const stopAll = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    try {
      await Promise.allSettled([
        interviewerAudioTransportService.stop(),
        candidateAudioTransportService.stop(),
      ]);
      screenVideoStream?.getTracks().forEach((track: MediaStreamTrack) => track.stop());
      setScreenVideoStream(null);
      if (videoRef.current) videoRef.current.srcObject = null;
      await sessionManager.endSession();
    } finally {
      stoppingRef.current = false;
    }
  }, [screenVideoStream]);

  const connect = useCallback(async () => {
    setWarning("");
    let displayMedia: MediaStream | null = null;
    let micMedia: MediaStream | null = null;
    let micWarning = "";

    try {
      displayMedia = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as any,
      });
      const systemAudio = displayMedia.getAudioTracks();
      if (systemAudio.length === 0) throw new Error("No shared system audio. Enable 'Share audio' in the browser picker.");

      const videoTracks = displayMedia.getVideoTracks();
      if (videoTracks.length > 0) {
        const videoStream = new MediaStream(videoTracks);
        setScreenVideoStream(videoStream);
        videoTracks[0].addEventListener("ended", () => void stopAll(), { once: true });
      }

      // Microphone capture is an optional enhancement. Never request permission unless
      // the user explicitly enables it, and never fail interviewer transcription if it is denied.
      if (captureCandidateMic) {
        try {
          micMedia = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: false,
          });
        } catch (error) {
          micWarning = isMicrophonePermissionError(error)
            ? "Microphone permission was denied. Continuing in interviewer-only mode. Your spoken answers will not be available for follow-up context."
            : "Microphone capture could not start. Continuing in interviewer-only mode.";
          console.warn("Optional candidate microphone unavailable; continuing without it", error);
        }
      }

      transcriptStateMachine.reset();
      const sessionInfo = pendingSessionInfoRef.current || undefined;
      pendingSessionInfoRef.current = null;
      sessionManager.startSession(sessionInfo);
      const background = localStorage.getItem("bg") || "";
      let speechContext = background;
      try {
        const knowledgeResponse = await fetch("/api/knowledge", { cache: "no-store" });
        if (knowledgeResponse.ok) {
          const knowledge = await knowledgeResponse.json();
          const keyterms = Array.isArray(knowledge?.keyterms) ? knowledge.keyterms.filter((value: unknown) => typeof value === "string") : [];
          speechContext = `${background} ${keyterms.join(" ")}`.trim();
        }
      } catch {
        // Knowledge hints improve transcription but must never block audio startup.
      }

      // System/interviewer audio is the required stream.
      await interviewerAudioTransportService.start(new MediaStream(systemAudio), speechContext);

      // Candidate audio is best-effort only.
      if (micMedia?.getAudioTracks().length) {
        try {
          await candidateAudioTransportService.start(micMedia, speechContext);
        } catch (error) {
          console.warn("Candidate microphone transcription failed; interviewer stream remains active", error);
          micMedia.getTracks().forEach((track: MediaStreamTrack) => track.stop());
          micWarning = "Interviewer transcription is live, but microphone transcription could not connect. Continuing in interviewer-only mode.";
        }
      }

      if (micWarning) setWarning(micWarning);
    } catch (error) {
      displayMedia?.getTracks().forEach((track: MediaStreamTrack) => track.stop());
      micMedia?.getTracks().forEach((track: MediaStreamTrack) => track.stop());
      await Promise.allSettled([
        interviewerAudioTransportService.stop(),
        candidateAudioTransportService.stop(),
      ]);
      setScreenVideoStream(null);
      setWarning(describeAudioStartError(error));
    }
  }, [captureCandidateMic, stopAll]);

  const toggle = useCallback(async () => {
    const active = [interviewerState, candidateState].some((state) => ["CONNECTING", "CONNECTED", "STREAMING", "RECONNECTING"].includes(state));
    if (active) await stopAll();
    else setSessionModalOpen(true);
  }, [candidateState, interviewerState, stopAll]);

  const handleSessionConfirm = useCallback(async (info: SessionInfo) => {
    setSessionModalOpen(false);
    pendingSessionInfoRef.current = info;
    await connect();
  }, [connect]);

  const handleSessionCancel = useCallback(() => {
    setSessionModalOpen(false);
  }, []);

  const interviewerStreaming = ["CONNECTED", "STREAMING"].includes(interviewerState);
  const candidateStreaming = ["CONNECTED", "STREAMING"].includes(candidateState);
  const connecting = [interviewerState, candidateState].some((state) => ["CONNECTING", "RECONNECTING"].includes(state));
  const sessionActive = [interviewerState, candidateState].some((state) => ["CONNECTING", "CONNECTED", "STREAMING", "RECONNECTING"].includes(state));

  return (
    <div className="w-full space-y-3">
      <div className="bg-white rounded-xl p-4 border border-slate-200/80 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-2 flex-1">
            <div className="flex items-center gap-3">
              <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center", interviewerStreaming ? "bg-emerald-50 text-emerald-600" : connecting ? "bg-amber-50 text-amber-600" : "bg-slate-100 text-slate-500")}>
                {interviewerStreaming ? <MicIcon className="h-5 w-5" /> : <MicOffIcon className="h-5 w-5" />}
              </div>
              <div>
                <h4 className="text-sm font-semibold text-slate-800">Meeting transcription</h4>
                <p className="text-xs text-slate-500">System audio = interviewer · your microphone is optional · Nova-3 PCM streaming</p>
              </div>
            </div>

            <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2">
              <Switch
                id="capture-candidate-mic"
                checked={captureCandidateMic}
                onCheckedChange={updateCaptureCandidateMic}
                disabled={sessionActive}
                aria-label="Capture my microphone for dual-speaker transcription"
              />
              <label htmlFor="capture-candidate-mic" className="cursor-pointer select-none">
                <span className="block text-xs font-semibold text-slate-700">Capture my microphone</span>
                <span className="block text-[11px] text-slate-500">
                  {captureCandidateMic
                    ? "Dual-speaker mode: your answers are included in follow-up context."
                    : "Interviewer-only mode: no microphone permission will be requested."}
                </span>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium">
              <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-1", interviewerStreaming ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 text-slate-500")}>
                <Volume2 className="w-3 h-3" /> Interviewer {interviewerStreaming ? "live" : interviewerState.toLowerCase()}
              </span>
              <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-1", candidateStreaming ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-500")}>
                <UserRound className="w-3 h-3" /> Me {captureCandidateMic ? (candidateStreaming ? "live" : candidateState.toLowerCase()) : "disabled"}
              </span>
              {interviewerStreaming && latencyMetrics?.captureToFinalMs ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-slate-600 font-mono">
                  <Activity className="w-3 h-3" /> STT final <Zap className="w-3 h-3" /> {latencyMetrics.captureToFinalMs}ms
                </span>
              ) : null}
            </div>
          </div>

          <Button
            className={cn("h-10 px-5 font-semibold text-xs rounded-lg", interviewerStreaming ? "bg-rose-600 hover:bg-rose-700 text-white" : "bg-emerald-600 hover:bg-emerald-700 text-white")}
            size="sm"
            onClick={toggle}
            disabled={connecting && !interviewerStreaming}
          >
            {interviewerStreaming ? "Disconnect" : connecting ? "Connecting..." : "Connect Audio"}
          </Button>
        </div>
        {warning && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{warning}</div>}
      </div>

      {screenVideoStream && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100 bg-slate-50/50">
            <span className="text-xs font-semibold text-slate-700">Shared screen preview</span>
            <button onClick={() => setIsPreviewMinimized((value: boolean) => !value)} className="text-xs text-slate-500 hover:text-slate-800">
              {isPreviewMinimized ? "Expand" : "Minimize"}
            </button>
          </div>
          {!isPreviewMinimized && <video ref={videoRef} className="w-full h-52 object-contain bg-slate-950" muted playsInline autoPlay />}
        </div>
      )}

      <SessionInfoModal
        open={sessionModalOpen}
        onConfirm={handleSessionConfirm}
        onCancel={handleSessionCancel}
      />
    </div>
  );
}
