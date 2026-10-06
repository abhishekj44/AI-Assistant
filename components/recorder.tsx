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
import { getSetting, useAppSetting } from "@/lib/clientSettings";
import { SESSION_PERSISTENCE_EVENT } from "@/lib/sessionPersistence";
import { interviewSpeechContext, microphonePolicy, startScopedCapture } from "@/lib/audio/capturePolicy";
import {
  AudioTransportError,
  candidateAudioTransportService,
  interviewerAudioTransportService,
  type ConnectionState,
  type LatencyMetrics,
} from "@/lib/audio/audioTransportService";

const CAPTURE_MIC_STORAGE_KEY = "meetingCopilot.captureCandidateMic";

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
  const micPreference = useAppSetting(CAPTURE_MIC_STORAGE_KEY, false);
  const [captureInfo, setCaptureInfo] = useState<SessionInfo | null>(null);
  const [starting, setStarting] = useState(false);
  const takingInterview = captureInfo?.callType === "taking_interview";
  const captureCandidateMic = takingInterview || micPreference.value;
  const [warning, setWarning] = useState<string>("");
  const [persistence, setPersistence] = useState<{ status: string; error?: string }>({ status: "saved" });
  const [sessionModalOpen, setSessionModalOpen] = useState(false);
  const mediaRef = useRef<MediaStream[]>([]);
  const startingRef = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const stoppingRef = useRef(false);

  useEffect(() => {
    const unsubInterviewer = interviewerAudioTransportService.onStateChange(setInterviewerState);
    const unsubCandidate = candidateAudioTransportService.onStateChange(setCandidateState);
    const unsubLatency = interviewerAudioTransportService.onLatencyUpdate(setLatencyMetrics);
    return () => { unsubInterviewer(); unsubCandidate(); unsubLatency(); };
  }, []);

  useEffect(() => {
    const update = (event: Event) => setPersistence((event as CustomEvent<{ status: string; error?: string }>).detail);
    window.addEventListener(SESSION_PERSISTENCE_EVENT, update);
    return () => window.removeEventListener(SESSION_PERSISTENCE_EVENT, update);
  }, []);

  useEffect(() => {
    if (!screenVideoStream || !videoRef.current) return;
    videoRef.current.srcObject = screenVideoStream;
    void videoRef.current.play().catch(() => undefined);
  }, [screenVideoStream]);

  const updateCaptureCandidateMic = useCallback((enabled: boolean) => {
    void micPreference.setValue(enabled).catch((error) => setWarning(error instanceof Error ? error.message : "Microphone preference save failed"));
  }, [micPreference.setValue]);

  const stopAll = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    try {
      await Promise.allSettled([
        interviewerAudioTransportService.stop(),
        candidateAudioTransportService.stop(),
      ]);
      mediaRef.current.forEach(stream => stream.getTracks().forEach(track => track.stop()));
      mediaRef.current = [];
      setScreenVideoStream(null);
      setCaptureInfo(null);
      if (videoRef.current) videoRef.current.srcObject = null;
      await sessionManager.endSession();
    } finally {
      stoppingRef.current = false;
    }
  }, []);

  const connect = useCallback(async (sessionInfo: SessionInfo) => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setCaptureInfo(sessionInfo);
    setWarning("");
    try {
      let speechContext = interviewSpeechContext(sessionInfo, sessionInfo.callType === "taking_interview" ? "" : getSetting("bg", ""));
      const loadSpeechContext = async () => {
        if (sessionInfo.callType === "taking_interview") return;
        try {
        const knowledgeResponse = await fetch("/api/knowledge", { cache: "no-store" });
        if (knowledgeResponse.ok) {
          const knowledge = await knowledgeResponse.json();
          const keyterms = Array.isArray(knowledge?.keyterms) ? knowledge.keyterms.filter((value: unknown) => typeof value === "string") : [];
          speechContext = [speechContext, ...keyterms.map((term: string) => `[TERM] ${term}`)].filter(Boolean).join("\n");
        }
        } catch {}
      };
      const result = await startScopedCapture(sessionInfo, micPreference.value, {
        getDisplay: () => navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } as MediaTrackConstraints,
        }),
        getMicrophone: () => navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
        }),
        startSession: () => { transcriptStateMachine.reset(); sessionManager.startSession(sessionInfo); },
        endSession: () => sessionManager.endSession(),
        startRemote: async stream => { await loadSpeechContext(); await interviewerAudioTransportService.start(new MediaStream(stream.getAudioTracks()), speechContext); },
        startLocal: stream => candidateAudioTransportService.start(stream, speechContext),
        stopRemote: () => interviewerAudioTransportService.stop(),
        stopLocal: () => candidateAudioTransportService.stop(),
      });
      mediaRef.current = [result.display, ...(result.microphone ? [result.microphone] : [])];
      const videoTracks = result.display.getVideoTracks();
      if (videoTracks.length) setScreenVideoStream(new MediaStream(videoTracks));
      const ended = () => {
        if (stoppingRef.current) return;
        setWarning(sessionInfo.callType === "taking_interview" ? "A required interview audio stream ended. Both-speaker capture stopped; reconnect to continue." : "Shared audio ended. Reconnect to continue.");
        void stopAll();
      };
      result.display.getTracks().forEach(track => track.addEventListener("ended", ended, { once: true }));
      if (microphonePolicy(sessionInfo, micPreference.value).required) result.microphone?.getTracks().forEach(track => track.addEventListener("ended", ended, { once: true }));
      if (result.warning) setWarning(result.warning);
    } catch (error) {
      mediaRef.current = [];
      setScreenVideoStream(null);
      setCaptureInfo(null);
      setWarning(describeAudioStartError(error));
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  }, [micPreference.value, stopAll]);

  const toggle = useCallback(async () => {
    const active = [interviewerState, candidateState].some((state) => ["CONNECTING", "CONNECTED", "STREAMING", "RECONNECTING"].includes(state));
    if (active || captureInfo) await stopAll();
    else setSessionModalOpen(true);
  }, [candidateState, interviewerState, captureInfo, stopAll]);

  const handleSessionConfirm = useCallback(async (info: SessionInfo) => {
    setSessionModalOpen(false);
    await connect(info);
  }, [connect]);

  const handleSessionCancel = useCallback(() => {
    setSessionModalOpen(false);
  }, []);

  const interviewerStreaming = ["CONNECTED", "STREAMING"].includes(interviewerState);
  const candidateStreaming = ["CONNECTED", "STREAMING"].includes(candidateState);
  const connecting = starting || [interviewerState, candidateState].some((state) => ["CONNECTING", "RECONNECTING"].includes(state));
  const sessionActive = starting || [interviewerState, candidateState].some((state) => ["CONNECTING", "CONNECTED", "STREAMING", "RECONNECTING"].includes(state));
  const requiredStreamWarning = takingInterview && !starting && (!interviewerStreaming || !candidateStreaming)
    ? "Both speakers are required for Taking Interview. An audio stream is disconnected or reconnecting; context may be incomplete." : "";

  return (
    <div className="w-full space-y-3">
      {micPreference.error && <p role="alert" className="text-xs text-rose-600">{micPreference.error}</p>}
      <div className="bg-white rounded-xl p-4 border border-slate-200/80 shadow-sm">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-2 flex-1">
            <div className="flex items-center gap-3">
              <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center", interviewerStreaming ? "bg-emerald-50 text-emerald-600" : connecting ? "bg-amber-50 text-amber-600" : "bg-slate-100 text-slate-500")}>
                {interviewerStreaming ? <MicIcon className="h-5 w-5" /> : <MicOffIcon className="h-5 w-5" />}
              </div>
              <div>
                <h4 className="text-sm font-semibold text-slate-800">Call transcription</h4>
                <p className="text-xs text-slate-500">{takingInterview ? "Remote candidate + local interviewer microphone (required)" : "System audio = remote participant; microphone optional"}</p>
              </div>
            </div>

            <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2">
              <Switch
                id="capture-candidate-mic"
                checked={captureCandidateMic}
                onCheckedChange={updateCaptureCandidateMic}
                disabled={takingInterview || sessionActive || !micPreference.ready}
                aria-label="Capture my microphone for dual-speaker transcription"
              />
              <label htmlFor="capture-candidate-mic" className="cursor-pointer select-none">
                <span className="block text-xs font-semibold text-slate-700">Capture my microphone</span>
                <span className="block text-[11px] text-slate-500">
                  {takingInterview ? "Required: your interviewer questions are included with the candidate's answers." : captureCandidateMic
                    ? "Dual-speaker mode: your answers are included in follow-up context."
                    : "Remote-only mode: no microphone permission will be requested."}
                </span>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium">
              <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-1", interviewerStreaming ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 text-slate-500")}>
                <Volume2 className="w-3 h-3" /> {takingInterview ? "Remote candidate" : "Remote"} {interviewerStreaming ? "live" : interviewerState.toLowerCase()}
              </span>
              <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-1", candidateStreaming ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-500")}>
                <UserRound className="w-3 h-3" /> {takingInterview ? "Local interviewer" : "Me"} {captureCandidateMic ? (candidateStreaming ? "live" : candidateState.toLowerCase()) : "disabled"}
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
            disabled={starting}
          >
            {starting ? "Connecting..." : captureInfo || sessionActive ? "Disconnect" : "Connect Audio"}
          </Button>
        </div>
        {warning && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{warning}</div>}
        {requiredStreamWarning && <p role="alert" className="mt-2 text-xs text-amber-700">{requiredStreamWarning}</p>}
        {persistence.status === "pending" && <p role="status" className="mt-2 text-[11px] text-slate-500">Saving transcript...</p>}
        {persistence.status === "error" && <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-rose-700"><span>{persistence.error || "Transcript save failed; pending turns retained."}</span><Button variant="outline" size="sm" onClick={() => sessionManager.retryPersistence()}>Retry Save</Button></div>}
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
