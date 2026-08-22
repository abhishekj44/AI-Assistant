/**
 * Production Session Manager for AI Interview Assistant
 * Handles:
 * 1. Session-based full transcript recording (Connect -> Disconnect) saved to localStorage
 * 2. Sliding window context extraction (limits raw prompt to recent ~2000 chars)
 * 3. Persistent rolling context summary (preserves context even when user clears UI)
 */

export interface SavedSession {
  id: string;
  startedAt: string;
  endedAt?: string;
  transcripts: Array<{ timestamp: string; text: string; speaker: string }>;
  summary: string;
}

const STORAGE_KEY_SESSIONS = "interview_sessions";
const STORAGE_KEY_ACTIVE_ID = "interview_active_session_id";
const MAX_RECENT_CHARS = 2000;

class SessionManager {
  private activeSession: SavedSession | null = null;

  constructor() {
    if (typeof window !== "undefined") {
      this.restoreActiveSession();
    }
  }

  /**
   * Start a new session when user clicks "Connect"
   */
  startSession(): SavedSession {
    const id = `session_${Date.now()}`;
    const newSession: SavedSession = {
      id,
      startedAt: new Date().toISOString(),
      transcripts: [],
      summary: "",
    };

    this.activeSession = newSession;
    this.saveToStorage();
    if (typeof window !== "undefined") {
      localStorage.setItem(STORAGE_KEY_ACTIVE_ID, id);
    }

    return newSession;
  }

  /**
   * Add a transcript item to the active session.
   * Stored independently of the UI display state.
   */
  addTranscript(text: string, speaker: string = "external") {
    if (!this.activeSession) {
      this.startSession();
    }

    if (!this.activeSession) return;

    // Check for exact duplicate of the last entry to prevent duplication
    const last = this.activeSession.transcripts[this.activeSession.transcripts.length - 1];
    if (last && last.text.trim() === text.trim()) {
      return;
    }

    this.activeSession.transcripts.push({
      timestamp: new Date().toLocaleTimeString(),
      text: text.trim(),
      speaker,
    });

    this.saveToStorage();
  }

  /**
   * End the current session on "Disconnect" and write file to ./sessions/
   */
  async endSession() {
    if (!this.activeSession) return;

    this.activeSession.endedAt = new Date().toISOString();
    this.saveToStorage();

    // Save session as JSON file in ./sessions/ directory
    await this.saveToServerDisk(this.activeSession);

    this.activeSession = null;

    if (typeof window !== "undefined") {
      localStorage.removeItem(STORAGE_KEY_ACTIVE_ID);
    }
  }

  private async saveToServerDisk(session: SavedSession) {
    try {
      await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(session),
      });
    } catch (err) {
      console.warn("Failed to save session file to disk:", err);
    }
  }

  /**
   * Get sliding window transcript (last ~2000 chars) for prompt construction.
   * Prevents LLM hallucination and high latency caused by bloated prompts.
   */
  getSlidingWindowTranscript(rawInput: string): string {
    if (!rawInput) return "";

    if (rawInput.length <= MAX_RECENT_CHARS) {
      return rawInput;
    }

    // Slice last MAX_RECENT_CHARS characters, aligning to the start of a sentence or line
    const sliced = rawInput.slice(-MAX_RECENT_CHARS);
    const firstNewline = sliced.indexOf("\n");

    if (firstNewline !== -1 && firstNewline < 200) {
      return sliced.slice(firstNewline + 1);
    }

    return sliced;
  }

  /**
   * Update the rolling summary (e.g., from AI response meta)
   */
  updateSummary(summaryText: string) {
    if (!this.activeSession || !summaryText.trim()) return;

    // Combine or replace rolling summary
    this.activeSession.summary = summaryText.trim();
    this.saveToStorage();
  }

  /**
   * Get the current rolling summary
   */
  getSummary(): string {
    return this.activeSession?.summary || "";
  }

  /**
   * Get the last N transcript entries as structured objects for LLM context.
   */
  getRecentTurns(n: number = 15): Array<{ timestamp: string; text: string; speaker: string }> {
    if (!this.activeSession) return [];
    return this.activeSession.transcripts.slice(-n);
  }

  /**
   * Get full session transcript as formatted string
   */
  getFullTranscriptString(): string {
    if (!this.activeSession) return "";

    return this.activeSession.transcripts
      .map((item) => `[${item.timestamp}] ${item.speaker.toUpperCase()}: ${item.text}`)
      .join("\n");
  }

  /**
   * Check if a session is currently active
   */
  isSessionActive(): boolean {
    return this.activeSession !== null;
  }

  /**
   * Get all completed and saved sessions
   */
  getAllSessions(): SavedSession[] {
    if (typeof window === "undefined") return [];
    try {
      const data = localStorage.getItem(STORAGE_KEY_SESSIONS);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  private saveToStorage() {
    if (typeof window === "undefined" || !this.activeSession) return;

    try {
      const sessions = this.getAllSessions();
      const existingIdx = sessions.findIndex((s) => s.id === this.activeSession?.id);

      if (existingIdx >= 0) {
        sessions[existingIdx] = this.activeSession;
      } else {
        sessions.push(this.activeSession);
      }

      localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(sessions));
    } catch (e) {
      console.warn("Failed to save session to localStorage:", e);
    }
  }

  private restoreActiveSession() {
    try {
      const activeId = localStorage.getItem(STORAGE_KEY_ACTIVE_ID);
      if (!activeId) return;

      const sessions = this.getAllSessions();
      const found = sessions.find((s) => s.id === activeId && !s.endedAt);
      if (found) {
        this.activeSession = found;
      }
    } catch {
      // Ignore storage errors
    }
  }
}

export const sessionManager = new SessionManager();
