import type { SpeakerRole, TranscriptTurn } from "@/lib/conversationTypes";

export type UtteranceSegment = TranscriptTurn;
export type TranscriptSubscriber = (utterances: UtteranceSegment[], currentInterim: string | null) => void;
export type UtteranceCompletedSubscriber = (utterance: UtteranceSegment) => void;

const MAX_IN_MEMORY_FINALIZED_TURNS = 600;
const MAX_UI_FINALIZED_TURNS = 180;

interface InFlightState {
  segments: string[];
  interim: string;
  audioStart?: number;
  audioEnd?: number;
  confidenceSamples: number[];
}

function newInFlight(): InFlightState {
  return { segments: [], interim: "", confidenceSamples: [] };
}

/**
 * Speaker-aware transcript state machine. System audio and microphone use independent
 * Deepgram streams, so each speaker requires an independent in-flight buffer.
 */
export class TranscriptStateMachine {
  private sequenceCounter = 0;
  private inFlight: Record<SpeakerRole, InFlightState> = {
    interviewer: newInFlight(),
    me: newInFlight(),
  };
  private finalizedUtterances: UtteranceSegment[] = [];
  private subscribers = new Set<TranscriptSubscriber>();
  private utteranceSubscribers = new Set<UtteranceCompletedSubscriber>();

  processTranscriptEvent(
    data: {
      channel: {
        alternatives: Array<{
          transcript: string;
          words?: Array<{
            word: string;
            punctuated_word?: string;
            start: number;
            end: number;
            confidence: number;
          }>;
          confidence?: number;
        }>;
      };
      is_final?: boolean;
      speech_final?: boolean;
      start?: number;
      duration?: number;
    },
    speaker: SpeakerRole,
  ) {
    const alternative = data.channel?.alternatives?.[0];
    if (!alternative) return;

    const words = alternative.words || [];
    const text = (words.length > 0
      ? words.map((word) => word.punctuated_word || word.word).join(" ")
      : alternative.transcript || ""
    ).trim();
    if (!text) return;

    const state = this.inFlight[speaker];
    const audioStart = words[0]?.start ?? data.start;
    const audioEnd =
      words[words.length - 1]?.end ??
      (data.start !== undefined && data.duration !== undefined ? data.start + data.duration : undefined);
    const confidence =
      typeof alternative.confidence === "number"
        ? alternative.confidence
        : words.length > 0
          ? words.reduce((sum, word) => sum + (word.confidence || 0), 0) / words.length
          : undefined;

    if (!data.is_final) {
      state.interim = text;
      this.notifySubscribers();
      return;
    }

    state.interim = "";
    state.segments.push(text);
    if (state.audioStart === undefined && audioStart !== undefined) state.audioStart = audioStart;
    if (audioEnd !== undefined) state.audioEnd = audioEnd;
    if (confidence !== undefined) state.confidenceSamples.push(confidence);

    if (data.speech_final) this.commitInFlightUtterance(speaker);
    else this.notifySubscribers();
  }

  /** Finalizes one Deepgram stream only; never flushes the other speaker's buffer. */
  finalizeCurrentUtterance(speaker?: SpeakerRole) {
    if (speaker) {
      this.flushSpeaker(speaker);
      return;
    }
    this.flushSpeaker("interviewer");
    this.flushSpeaker("me");
  }

  private flushSpeaker(speaker: SpeakerRole) {
    const state = this.inFlight[speaker];
    if (state.segments.length === 0 && state.interim) {
      state.segments.push(state.interim);
      state.interim = "";
    }
    if (state.segments.length > 0) this.commitInFlightUtterance(speaker);
  }

  private commitInFlightUtterance(speaker: SpeakerRole) {
    const state = this.inFlight[speaker];
    const fullText = state.segments.join(" ").replace(/\s+/g, " ").trim();
    if (!fullText) {
      this.inFlight[speaker] = newInFlight();
      return;
    }

    this.sequenceCounter += 1;
    const confidence = state.confidenceSamples.length
      ? state.confidenceSamples.reduce((sum, value) => sum + value, 0) / state.confidenceSamples.length
      : undefined;

    const utterance: UtteranceSegment = {
      id: `utt_${Date.now()}_${this.sequenceCounter}`,
      sequenceId: this.sequenceCounter,
      speaker,
      text: fullText,
      audioStart: state.audioStart,
      audioEnd: state.audioEnd,
      confidence,
      timestamp: new Date().toISOString(),
      isInterim: false,
    };

    this.finalizedUtterances.push(utterance);
    if (this.finalizedUtterances.length > MAX_IN_MEMORY_FINALIZED_TURNS) {
      this.finalizedUtterances.splice(0, this.finalizedUtterances.length - MAX_IN_MEMORY_FINALIZED_TURNS);
    }
    this.inFlight[speaker] = newInFlight();
    this.notifySubscribers();

    for (const subscriber of this.utteranceSubscribers) {
      try {
        subscriber(utterance);
      } catch (error) {
        console.error("Transcript utterance subscriber failed:", error);
      }
    }
  }

  subscribe(subscriber: TranscriptSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.getAllMessages(), this.getInterimText());
    return () => this.subscribers.delete(subscriber);
  }

  onUtteranceCompleted(subscriber: UtteranceCompletedSubscriber): () => void {
    this.utteranceSubscribers.add(subscriber);
    return () => this.utteranceSubscribers.delete(subscriber);
  }

  getAllMessages(): UtteranceSegment[] {
    const messages = this.finalizedUtterances.slice(-MAX_UI_FINALIZED_TURNS);
    for (const speaker of ["interviewer", "me"] as const) {
      const state = this.inFlight[speaker];
      const text = [...state.segments, state.interim].filter(Boolean).join(" ").trim();
      if (!text) continue;
      messages.push({
        id: `active_preview_${speaker}`,
        sequenceId: this.sequenceCounter + (speaker === "interviewer" ? 0.1 : 0.2),
        speaker,
        text,
        timestamp: new Date().toISOString(),
        audioStart: state.audioStart,
        audioEnd: state.audioEnd,
        isInterim: true,
      });
    }
    return messages.sort((a, b) => a.sequenceId - b.sequenceId);
  }

  getFormattedHistory(): string {
    return this.finalizedUtterances
      .map((turn) => `${turn.speaker === "me" ? "ME" : "INTERVIEWER"}: ${turn.text}`)
      .join("\n");
  }

  reset() {
    this.sequenceCounter = 0;
    this.inFlight = { interviewer: newInFlight(), me: newInFlight() };
    this.finalizedUtterances = [];
    this.notifySubscribers();
  }

  getRecentFinalizedTurns(n = 12): UtteranceSegment[] {
    return this.finalizedUtterances.slice(-Math.max(1, Math.min(n, 50)));
  }

  /**
   * Coalesces only the current interviewer thought. A candidate turn or a long pause
   * forms a hard boundary, preventing unrelated historical questions from being merged.
   */
  getLatestQuestionContext(maxTurns = 3, minTotalLength = 2, maxGapMs = 3_500): string {
    const activeState = this.inFlight.interviewer;
    const activeText = [...activeState.segments, activeState.interim].filter(Boolean).join(" ").trim();
    const collected: string[] = activeText ? [activeText] : [];
    let newerTimestamp = activeText ? Date.now() : Number.POSITIVE_INFINITY;

    // If ME has spoken since the last interviewer turn and there is no new interviewer audio,
    // do not silently reuse an already-answered historical question.
    if (!activeText) {
      const latest = this.finalizedUtterances.at(-1);
      if (latest?.speaker === "me") return "";
    }

    for (let i = this.finalizedUtterances.length - 1; i >= 0; i -= 1) {
      const turn = this.finalizedUtterances[i];
      if (turn.speaker === "me") {
        if (collected.length > 0) break;
        return "";
      }
      if (!turn.text.trim()) continue;

      const turnTime = Date.parse(turn.timestamp);
      if (Number.isFinite(newerTimestamp) && newerTimestamp !== Number.POSITIVE_INFINITY) {
        const gap = newerTimestamp - turnTime;
        if (gap > maxGapMs && collected.length > 0) break;
      }

      collected.unshift(turn.text.trim());
      newerTimestamp = turnTime;
      if (collected.length >= maxTurns) break;
    }

    const question = collected.join(" ").replace(/\s+/g, " ").trim();
    if (question.length >= minTotalLength) return question;
    return this.getLatestInterviewerTurn(minTotalLength)?.text || "";
  }

  getLatestInterviewerTurn(minLength = 2): UtteranceSegment | null {
    for (let i = this.finalizedUtterances.length - 1; i >= 0; i -= 1) {
      const turn = this.finalizedUtterances[i];
      if (turn.speaker === "interviewer" && turn.text.trim().length >= minLength) return turn;
    }
    return null;
  }

  getLatestSequenceId(): number {
    return this.sequenceCounter;
  }

  private getInterimText(): string | null {
    const values = (["interviewer", "me"] as const)
      .map((speaker) => {
        const state = this.inFlight[speaker];
        return [...state.segments, state.interim].filter(Boolean).join(" ").trim();
      })
      .filter(Boolean);
    return values.length ? values.join("\n") : null;
  }

  private notifySubscribers() {
    const messages = this.getAllMessages();
    const interim = this.getInterimText();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(messages, interim);
      } catch (error) {
        console.error("Transcript subscriber failed:", error);
      }
    }
  }
}

export const transcriptStateMachine = new TranscriptStateMachine();
