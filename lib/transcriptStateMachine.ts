/**
 * Production Transcript State Machine
 * 
 * Replaces heuristic text-deduplication, 1-second debounce, and arbitrary min-length filtering
 * with a deterministic 3-tier state machine:
 * 
 * 1. Interim Hypothesis (is_final === false):
 *    Transient preview of speech in-progress. Replaces previous interim. Never committed to history.
 * 
 * 2. Segment Buffer (is_final === true, speech_final === false):
 *    Audio range has been finalized by Deepgram. Appended to current in-flight utterance.
 * 
 * 3. Sealed Utterance (speech_final === true OR UtteranceEnd):
 *    Speaker has paused/finished thought. Seals the utterance, generates sequence ID,
 *    records audio timestamps, and notifies subscribers (UI, Storage, LLM Context).
 */

export interface UtteranceSegment {
  id: string;
  sequenceId: number;
  speaker: 'user' | 'system' | 'external';
  text: string;
  audioStart?: number;
  audioEnd?: number;
  confidence?: number;
  timestamp: string;
  isInterim: boolean;
}

export type TranscriptSubscriber = (utterances: UtteranceSegment[], currentInterim: string | null) => void;
export type UtteranceCompletedSubscriber = (utterance: UtteranceSegment) => void;

export class TranscriptStateMachine {
  private sequenceCounter: number = 0;
  private currentInterimText: string = "";
  private inFlightSegments: string[] = [];
  private inFlightAudioStart: number | undefined = undefined;
  private inFlightAudioEnd: number | undefined = undefined;
  private inFlightSpeaker: 'user' | 'system' | 'external' = 'external';

  private finalizedUtterances: UtteranceSegment[] = [];
  private subscribers: Set<TranscriptSubscriber> = new Set();
  private utteranceSubscribers: Set<UtteranceCompletedSubscriber> = new Set();

  /**
   * Process a live transcription event from Deepgram
   */
  processTranscriptEvent(data: {
    channel: {
      alternatives: Array<{
        transcript: string;
        words?: Array<{ word: string; punctuated_word?: string; start: number; end: number; confidence: number }>;
        confidence?: number;
      }>;
    };
    is_final?: boolean;
    speech_final?: boolean;
    start?: number;
    duration?: number;
  }, speaker: 'user' | 'system' | 'external' = 'external') {
    const alternative = data.channel?.alternatives?.[0];
    if (!alternative) return;

    const words = alternative.words || [];
    const text = (
      words.length > 0
        ? words.map((w) => w.punctuated_word || w.word).join(" ")
        : alternative.transcript
    ).trim();

    if (!text) return;

    const isFinal = Boolean(data.is_final);
    const speechFinal = Boolean(data.speech_final);

    // Audio timestamps
    const audioStart = words[0]?.start ?? data.start;
    const audioEnd = words[words.length - 1]?.end ?? (data.start !== undefined && data.duration !== undefined ? data.start + data.duration : undefined);

    if (!isFinal) {
      // 1. Transient Interim Hypothesis
      this.currentInterimText = text;
      this.notifySubscribers();
      return;
    }

    // 2. Finalized Segment (is_final === true)
    this.currentInterimText = "";
    this.inFlightSpeaker = speaker;
    this.inFlightSegments.push(text);

    if (this.inFlightAudioStart === undefined && audioStart !== undefined) {
      this.inFlightAudioStart = audioStart;
    }
    if (audioEnd !== undefined) {
      this.inFlightAudioEnd = audioEnd;
    }

    if (speechFinal) {
      // 3. Utterance Finalized (speech_final === true)
      this.commitInFlightUtterance();
    } else {
      this.notifySubscribers();
    }
  }

  /**
   * Explicit utterance end signal (e.g. from Deepgram UtteranceEnd event or manual flush)
   */
  finalizeCurrentUtterance() {
    if (this.inFlightSegments.length > 0) {
      this.commitInFlightUtterance();
    } else if (this.currentInterimText) {
      // If there was only an interim text hanging on flush, commit it as a segment
      this.inFlightSegments.push(this.currentInterimText);
      this.currentInterimText = "";
      this.commitInFlightUtterance();
    }
  }

  private commitInFlightUtterance() {
    if (this.inFlightSegments.length === 0) return;

    const fullText = this.inFlightSegments.join(" ").trim();
    if (!fullText) {
      this.inFlightSegments = [];
      return;
    }

    this.sequenceCounter++;
    const utterance: UtteranceSegment = {
      id: `utt_${Date.now()}_${this.sequenceCounter}`,
      sequenceId: this.sequenceCounter,
      speaker: this.inFlightSpeaker,
      text: fullText,
      audioStart: this.inFlightAudioStart,
      audioEnd: this.inFlightAudioEnd,
      timestamp: new Date().toISOString(),
      isInterim: false,
    };

    this.finalizedUtterances.push(utterance);

    // Reset in-flight buffer
    this.inFlightSegments = [];
    this.inFlightAudioStart = undefined;
    this.inFlightAudioEnd = undefined;
    this.currentInterimText = "";

    // Notify listeners
    this.notifySubscribers();
    this.utteranceSubscribers.forEach((sub) => {
      try {
        sub(utterance);
      } catch (err) {
        console.error("Error in utterance completed subscriber:", err);
      }
    });
  }

  /**
   * Subscribe to transcript state changes (for UI feed rendering)
   */
  subscribe(subscriber: TranscriptSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.getAllMessages(), this.currentInterimText || null);
    return () => this.subscribers.delete(subscriber);
  }

  /**
   * Subscribe to completed utterances (for LLM context updates, storage, etc.)
   */
  onUtteranceCompleted(subscriber: UtteranceCompletedSubscriber): () => void {
    this.utteranceSubscribers.add(subscriber);
    return () => this.utteranceSubscribers.delete(subscriber);
  }

  /**
   * Get all messages formatted for UI display (finalized + in-flight interim preview)
   */
  getAllMessages(): UtteranceSegment[] {
    const list = [...this.finalizedUtterances];

    // If there's an in-flight unsealed utterance or interim text, display as interim
    const currentInFlight = this.inFlightSegments.join(" ").trim();
    const activePreview = [currentInFlight, this.currentInterimText].filter(Boolean).join(" ").trim();

    if (activePreview) {
      list.push({
        id: "active_preview",
        sequenceId: this.sequenceCounter + 1,
        speaker: this.inFlightSpeaker,
        text: activePreview,
        audioStart: this.inFlightAudioStart,
        audioEnd: this.inFlightAudioEnd,
        timestamp: new Date().toISOString(),
        isInterim: true,
      });
    }

    return list;
  }

  /**
   * Formatted string of all finalized text with timestamps
   */
  getFormattedHistory(): string {
    return this.finalizedUtterances
      .map((u) => `[${new Date(u.timestamp).toLocaleTimeString()}] ${u.text}`)
      .join("\n");
  }

  /**
   * Reset the transcript state (e.g. on new session or UI clear)
   */
  reset() {
    this.currentInterimText = "";
    this.inFlightSegments = [];
    this.inFlightAudioStart = undefined;
    this.inFlightAudioEnd = undefined;
    this.finalizedUtterances = [];
    this.notifySubscribers();
  }

  /**
   * Get the last N finalized (sealed) utterances for structured LLM context.
   */
  getRecentFinalizedTurns(n: number = 15): UtteranceSegment[] {
    return this.finalizedUtterances.slice(-n);
  }

  /**
   * Get the complete recent question context by coalescing consecutive recent utterances
   * from the interviewer/speaker, including any in-flight or interim text.
   * This prevents losing context when an interviewer pauses and Deepgram splits their thought into multiple utterances.
   */
  getLatestQuestionContext(maxTurns: number = 5, minTotalLength: number = 10): string {
    const collected: string[] = [];

    // Traverse finalized utterances backwards, gathering consecutive turns from the other speaker
    for (let i = this.finalizedUtterances.length - 1; i >= 0; i--) {
      const utt = this.finalizedUtterances[i];
      if (utt.speaker === 'user' && collected.length > 0) {
        // Stop once we hit a user turn (boundary between previous answer and current question)
        break;
      }
      if (utt.text.trim()) {
        collected.unshift(utt.text.trim());
      }
      if (collected.length >= maxTurns) {
        break;
      }
    }

    // Include any in-flight segments or interim text currently being spoken
    const currentInFlight = this.inFlightSegments.join(" ").trim();
    const activePreview = [currentInFlight, this.currentInterimText].filter(Boolean).join(" ").trim();
    if (activePreview) {
      collected.push(activePreview);
    }

    const fullQuestion = collected.join(" ").trim();
    if (fullQuestion.length >= minTotalLength) {
      return fullQuestion;
    }

    const single = this.getLatestOtherSpeakerTurn(minTotalLength);
    return single?.text || "";
  }

  /**
   * Get the most recent non-trivial finalized utterance (>15 chars).
   */
  getLatestOtherSpeakerTurn(minLength: number = 15): UtteranceSegment | null {
    for (let i = this.finalizedUtterances.length - 1; i >= 0; i--) {
      const utt = this.finalizedUtterances[i];
      if (utt.text.length >= minLength) {
        return utt;
      }
    }
    return null;
  }


  private notifySubscribers() {
    const messages = this.getAllMessages();
    const interim = this.currentInterimText || (this.inFlightSegments.length > 0 ? this.inFlightSegments.join(" ") : null);
    this.subscribers.forEach((sub) => {
      try {
        sub(messages, interim);
      } catch (err) {
        console.error("Error in transcript subscriber:", err);
      }
    });
  }
}

export const transcriptStateMachine = new TranscriptStateMachine();
