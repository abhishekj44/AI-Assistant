import type { SessionInfo } from "../conversationTypes";

export function microphonePolicy(info: SessionInfo, preference: boolean) {
  const required = info.callType === "taking_interview";
  return { required, capture: required || preference };
}

export function sessionSetupError(info: SessionInfo, basesReady = true): string {
  if (info.callType === "giving_interview" && !info.jobDescription?.trim()) return "Job description is required.";
  if (info.callType === "taking_interview" && !info.candidateProfile?.trim()) return "Candidate profile is required.";
  if ((info.jobDescription?.length ?? 0) > 12000 || (info.candidateProfile?.length ?? 0) > 12000) return "Interview context must be at most 12,000 characters.";
  if (info.callType === "giving_interview" && (info.jobTitle?.length ?? 0) > 200) return "Job title must be at most 200 characters.";
  if (info.callType === "giving_interview" && (info.seniority?.length ?? 0) > 100) return "Seniority must be at most 100 characters.";
  if (info.callType === "meeting" && (!basesReady || !info.knowledgeBaseIds?.length || info.knowledgeBaseIds.length > 20)) return "Select 1 to 20 knowledge bases.";
  return "";
}

export function prepareSessionInfo(info: SessionInfo): SessionInfo {
  const { jobTitle, jobDescription, seniority, candidateProfile, ...common } = info;
  return {
    ...common,
    knowledgeBaseIds: info.callType === "giving_interview" ? ["personal-knowledge"] : info.callType === "taking_interview" ? [] : info.knowledgeBaseIds,
    ...(info.callType === "giving_interview" ? { jobTitle: jobTitle?.trim() ?? "", jobDescription: jobDescription?.trim() ?? "", seniority: seniority?.trim() ?? "" } : {}),
    ...(info.callType === "taking_interview" ? { candidateProfile: candidateProfile?.trim() ?? "" } : {}),
  };
}

export function interviewSpeechContext(info: SessionInfo, background: string): string {
  return [info.callType === "taking_interview" ? "" : background,
    ...[info.company, info.details].filter(value => value.trim()).map(value => `[TERM] ${value.replace(/[\r\n]+/g, " ")}`),
    info.callType === "taking_interview" ? info.candidateProfile : info.jobDescription].filter(Boolean).join("\n");
}

interface CaptureDependencies {
  getDisplay: () => Promise<MediaStream>;
  getMicrophone: () => Promise<MediaStream>;
  startRemote: (stream: MediaStream) => Promise<void>;
  startLocal: (stream: MediaStream) => Promise<void>;
  stopRemote: () => Promise<unknown>;
  stopLocal: () => Promise<unknown>;
  startSession: () => void | Promise<unknown>;
  endSession: () => Promise<unknown>;
}

export async function startScopedCapture(info: SessionInfo, preference: boolean, dependencies: CaptureDependencies) {
  const policy = microphonePolicy(info, preference);
  let display: MediaStream | undefined;
  let microphone: MediaStream | undefined;
  let committingSession = false;
  let warning = "";
  try {
    display = await dependencies.getDisplay();
    if (!display.getAudioTracks().length) throw new Error("No shared system audio. Enable 'Share audio' in the browser picker.");
    if (policy.capture) {
      try {
        microphone = await dependencies.getMicrophone();
        if (!microphone.getAudioTracks().length) throw new Error("No microphone audio track was provided.");
      } catch (error) {
        microphone?.getTracks().forEach(track => track.stop());
        microphone = undefined;
        if (policy.required) throw new Error(`Taking Interview requires microphone permission and audio. ${error instanceof Error ? error.message : "Microphone unavailable."}`);
        warning = "Microphone unavailable or permission denied. Continuing with remote audio only.";
      }
    }
    committingSession = true;
    await dependencies.startSession();
    await dependencies.startRemote(display);
    if (microphone) {
      try { await dependencies.startLocal(microphone); }
      catch (error) {
        if (policy.required) throw new Error(`Taking Interview requires microphone transcription. ${error instanceof Error ? error.message : "Connection failed."}`);
        await dependencies.stopLocal();
        microphone.getTracks().forEach(track => track.stop());
        microphone = undefined;
        warning = "Microphone transcription could not connect. Continuing with remote audio only.";
      }
    }
    return { display, microphone, warning };
  } catch (error) {
    display?.getTracks().forEach(track => track.stop());
    microphone?.getTracks().forEach(track => track.stop());
    await Promise.allSettled([dependencies.stopRemote(), dependencies.stopLocal()]);
    if (committingSession) await dependencies.endSession().catch(() => undefined);
    throw error;
  }
}