"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { MicIcon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MicOffIcon, Activity, Zap } from "lucide-react";
import { sessionManager } from "@/lib/sessionManager";
import { audioTransportService, ConnectionState, LatencyMetrics } from "@/lib/audio/audioTransportService";

interface RecorderTranscriberProps {
  addTextinTranscription?: (text: string, speaker?: 'user' | 'system' | 'external') => void;
}

export default function RecorderTranscriber({
  addTextinTranscription,
}: RecorderTranscriberProps) {
  const [connectionState, setConnectionState] = useState<ConnectionState>("DISCONNECTED");
  const [latencyMetrics, setLatencyMetrics] = useState<LatencyMetrics | null>(null);
  const [screenVideoStream, setScreenVideoStream] = useState<MediaStream | null>(null);
  const [isPreviewMinimized, setIsPreviewMinimized] = useState(false);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Subscribe to transport state & latency metrics
  useEffect(() => {
    const unsubState = audioTransportService.onStateChange((state) => {
      setConnectionState(state);
    });

    const unsubLatency = audioTransportService.onLatencyUpdate((metrics) => {
      setLatencyMetrics(metrics);
    });

    return () => {
      unsubState();
      unsubLatency();
    };
  }, []);

  // Update video element when screen stream changes
  useEffect(() => {
    if (screenVideoStream && videoRef.current) {
      setVideoLoaded(false);
      videoRef.current.srcObject = screenVideoStream;
      videoRef.current.play().catch((error) => {
        console.error("Video preview play error:", error);
      });
    }
  }, [screenVideoStream]);

  const toggleRecorderTranscriber = useCallback(async () => {
    if (connectionState === "STREAMING" || connectionState === "CONNECTED" || connectionState === "CONNECTING") {
      // Graceful Disconnect
      try {
        await audioTransportService.stop();
        if (screenVideoStream) {
          screenVideoStream.getTracks().forEach((track) => track.stop());
          setScreenVideoStream(null);
        }
        if (videoRef.current) {
          videoRef.current.srcObject = null;
        }
        setVideoLoaded(false);
        await sessionManager.endSession();
      } catch (err) {
        console.error("Error stopping recorder:", err);
      }
    } else {
      // Connect
      try {
        const displayMedia = await navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          } as any,
        });

        // 1. Video track for preview
        const videoTracks = displayMedia.getVideoTracks();
        if (videoTracks.length > 0) {
          const videoStream = new MediaStream(videoTracks);
          setScreenVideoStream(videoStream);
        }

        // 2. Audio track for real-time AudioWorklet transport
        const audioTracks = displayMedia.getAudioTracks();
        if (audioTracks.length === 0) {
          alert("No system audio detected. Please make sure to check 'Share audio' in the browser screen-sharing dialog.");
          displayMedia.getTracks().forEach((t) => t.stop());
          return;
        }

        const audioOnlyStream = new MediaStream(audioTracks);

        // Start session storage & zero-copy PCM transport with keyterms boosting
        const savedBg = typeof window !== "undefined" ? localStorage.getItem("bg") || "" : "";
        sessionManager.startSession();
        await audioTransportService.start(audioOnlyStream, "external", savedBg);
      } catch (error) {
        console.error("Error accessing screen/audio devices:", error);
      }
    }
  }, [connectionState, screenVideoStream]);

  const isStreaming = connectionState === "STREAMING" || connectionState === "CONNECTED";
  const isConnecting = connectionState === "CONNECTING" || connectionState === "RECONNECTING";

  return (
    <div className="w-full space-y-4">
      {/* Control Card */}
      <div className="bg-white rounded-xl p-4 border border-slate-200/80 shadow-sm flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "w-10 h-10 rounded-xl flex items-center justify-center transition-all",
              isStreaming
                ? "bg-emerald-50 text-emerald-600 badge-glow-emerald"
                : isConnecting
                ? "bg-amber-50 text-amber-600 animate-pulse"
                : "bg-slate-100 text-slate-500"
            )}
          >
            {isStreaming ? (
              <MicIcon className="h-5 w-5 animate-pulse" />
            ) : (
              <MicOffIcon className="h-5 w-5" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold text-slate-800">
                {isStreaming
                  ? "AudioWorklet Stream Active"
                  : isConnecting
                  ? "Connecting Audio Pipeline..."
                  : "Interviewer Audio"}
              </h4>
              {isStreaming && (
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1 font-semibold">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
                  Nova-3 (16kHz PCM)
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500">
              {isStreaming
                ? "Zero-copy 32ms frame streaming directly to Deepgram"
                : "Click connect to start capturing interviewer screen & audio"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Real-time Latency Telemetry Pill */}
          {isStreaming && latencyMetrics && (
            <div className="hidden sm:flex items-center gap-2 bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-200 text-[11px] font-mono text-slate-600">
              <Activity className="w-3.5 h-3.5 text-indigo-500" />
              <span>
                Cap➔Send: <b>{latencyMetrics.captureToSendMs}ms</b>
              </span>
              {latencyMetrics.captureToFinalMs > 0 && (
                <>
                  <span className="text-slate-300">|</span>
                  <span className="text-emerald-600 flex items-center gap-0.5">
                    <Zap className="w-3 h-3" />
                    Final: <b>{latencyMetrics.captureToFinalMs}ms</b>
                  </span>
                </>
              )}
            </div>
          )}

          <Button
            className={cn(
              "h-10 px-5 font-semibold text-xs transition-all shadow-sm rounded-lg",
              isStreaming
                ? "bg-rose-600 hover:bg-rose-700 text-white"
                : isConnecting
                ? "bg-amber-600 hover:bg-amber-700 text-white"
                : "bg-emerald-600 hover:bg-emerald-700 text-white"
            )}
            size="sm"
            onClick={toggleRecorderTranscriber}
          >
            {isStreaming ? (
              <div className="flex items-center gap-1.5">
                <MicOffIcon className="h-4 w-4" />
                Disconnect
              </div>
            ) : isConnecting ? (
              <div className="flex items-center gap-1.5">
                <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                Connecting...
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <MicIcon className="h-4 w-4" />
                Connect Audio
              </div>
            )}
          </Button>
        </div>
      </div>

      {/* Screen Sharing Video Card */}
      {screenVideoStream && (
        <div className="bg-white rounded-xl border border-slate-200/80 shadow-sm overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-slate-50/50">
            <h3 className="text-xs font-semibold text-slate-700 flex items-center gap-2">
              <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
              Live Screen Stream
            </h3>
            <button
              onClick={() => setIsPreviewMinimized(!isPreviewMinimized)}
              className="text-xs text-slate-500 hover:text-slate-800 font-medium hover:underline"
            >
              {isPreviewMinimized ? "Expand Preview" : "Minimize"}
            </button>
          </div>

          {!isPreviewMinimized && (
            <div className="relative bg-slate-950">
              <video
                ref={videoRef}
                className="w-full h-52 object-contain"
                muted
                playsInline
                autoPlay
                controls={false}
                onLoadedMetadata={() => setVideoLoaded(true)}
                onError={() => setVideoLoaded(false)}
              />
              {!videoLoaded && (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/90 text-slate-300">
                  <div className="w-5 h-5 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mb-2"></div>
                  <p className="text-xs">Connecting Video Source...</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
