import type { MeetingMemory, SessionInfo, TranscriptTurn } from "@/lib/conversationTypes";
import { EMPTY_MEETING_MEMORY } from "@/lib/conversationTypes";

export interface SavedSession {
  id: string;
  startedAt: string;
  endedAt?: string;
  transcripts: TranscriptTurn[];
  memory: MeetingMemory;
  sessionInfo?: SessionInfo;
}

const STORAGE_KEY_SESSIONS = "interview_sessions_v3";
const STORAGE_KEY_ACTIVE_ID = "interview_active_session_id_v3";
const MEMORY_REFRESH_EVERY_TURNS = 8;
const MAX_LOCAL_SESSIONS = 6;
const MAX_TURNS_PER_LOCAL_SESSION = 600;
const LOCAL_PERSIST_DEBOUNCE_MS = 750;

class SessionManager {
  private activeSession: SavedSession | null = null;
  private memoryRefreshInFlight = false;
  private turnsSinceMemoryRefresh = 0;
  private memoryRetryAfter = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof window !== "undefined") this.restoreActiveSession();
  }

  startSession(info?: SessionInfo): SavedSession {
    const session: SavedSession = {
      id: `session_${Date.now()}`,
      startedAt: new Date().toISOString(),
      transcripts: [],
      memory: { ...EMPTY_MEETING_MEMORY },
      ...(info ? { sessionInfo: info } : {}),
    };
    this.activeSession = session;
    this.turnsSinceMemoryRefresh = 0;
    this.memoryRetryAfter = 0;
    this.saveToStorage();
    if (typeof window !== "undefined") {
      try { localStorage.setItem(STORAGE_KEY_ACTIVE_ID, session.id); } catch { /* non-fatal */ }
    }
    return session;
  }

  addTranscript(turn: TranscriptTurn) {
    if (!this.activeSession) this.startSession();
    if (!this.activeSession || !turn.text.trim()) return;
    const last = this.activeSession.transcripts.at(-1);
    if (last?.id === turn.id) return;

    this.activeSession.transcripts.push({ ...turn, text: turn.text.trim(), isInterim: false });
    if (this.activeSession.transcripts.length > MAX_TURNS_PER_LOCAL_SESSION) {
      this.activeSession.transcripts.splice(0, this.activeSession.transcripts.length - MAX_TURNS_PER_LOCAL_SESSION);
    }
    this.turnsSinceMemoryRefresh += 1;
    this.scheduleSaveToStorage();
    void this.refreshMemoryIfDue();
  }

  async endSession() {
    if (!this.activeSession) return;
    await this.refreshMemory(true).catch(() => undefined);
    this.activeSession.endedAt = new Date().toISOString();
    this.cancelScheduledPersist();
    this.saveToStorage();
    await this.saveToServerDisk(this.activeSession);
    this.activeSession = null;
    this.turnsSinceMemoryRefresh = 0;
    this.memoryRetryAfter = 0;
    if (typeof window !== "undefined") {
      try { localStorage.removeItem(STORAGE_KEY_ACTIVE_ID); } catch { /* non-fatal */ }
    }
  }

  getMemory(): MeetingMemory {
    return this.activeSession?.memory || { ...EMPTY_MEETING_MEMORY };
  }

  getSummary(): string {
    return this.getMemory().summary;
  }

  getRecentTurns(n = 12): TranscriptTurn[] {
    return this.activeSession?.transcripts.slice(-Math.max(1, Math.min(n, 50))) || [];
  }

  getSessionId(): string | undefined {
    return this.activeSession?.id;
  }

  getFullTranscriptString(): string {
    return (this.activeSession?.transcripts || [])
      .map((turn) => `${turn.speaker === "me" ? "ME" : "INTERVIEWER"}: ${turn.text}`)
      .join("\n");
  }

  isSessionActive(): boolean {
    return Boolean(this.activeSession);
  }

  getAllSessions(): SavedSession[] {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SESSIONS);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private async refreshMemoryIfDue() {
    if (Date.now() < this.memoryRetryAfter) return;
    if (this.turnsSinceMemoryRefresh < MEMORY_REFRESH_EVERY_TURNS) return;
    await this.refreshMemory(false);
  }

  private async refreshMemory(force: boolean) {
    if (!this.activeSession || this.memoryRefreshInFlight) return;
    if (!force && this.turnsSinceMemoryRefresh < MEMORY_REFRESH_EVERY_TURNS) return;
    if (this.activeSession.transcripts.length < 2) return;

    this.memoryRefreshInFlight = true;
    const sessionId = this.activeSession.id;
    try {
      const response = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          previousMemory: this.activeSession.memory,
          turns: this.activeSession.transcripts.slice(-24),
        }),
      });
      if (!response.ok) {
        this.memoryRetryAfter = Date.now() + 30_000;
        return;
      }
      const payload = await response.json();
      if (this.activeSession?.id !== sessionId || !payload?.memory) return;
      this.activeSession.memory = payload.memory;
      this.turnsSinceMemoryRefresh = 0;
      this.memoryRetryAfter = 0;
      this.scheduleSaveToStorage();
    } catch (error) {
      this.memoryRetryAfter = Date.now() + 30_000;
      console.warn("Meeting-memory refresh failed; continuing with recent turns", error);
    } finally {
      this.memoryRefreshInFlight = false;
    }
  }

  private async saveToServerDisk(session: SavedSession) {
    try {
      await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(session),
      });
    } catch (error) {
      console.warn("Failed to persist session to server disk", error);
    }
  }

  private scheduleSaveToStorage() {
    if (typeof window === "undefined" || !this.activeSession || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.saveToStorage();
    }, LOCAL_PERSIST_DEBOUNCE_MS);
  }

  private cancelScheduledPersist() {
    if (!this.persistTimer) return;
    clearTimeout(this.persistTimer);
    this.persistTimer = null;
  }

  private saveToStorage() {
    if (typeof window === "undefined" || !this.activeSession) return;
    try {
      const sessions = this.getAllSessions();
      const index = sessions.findIndex((session) => session.id === this.activeSession?.id);
      if (index >= 0) sessions[index] = this.activeSession;
      else sessions.push(this.activeSession);
      const trimmed = sessions
        .map((session) => ({ ...session, transcripts: (session.transcripts || []).slice(-MAX_TURNS_PER_LOCAL_SESSION) }))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, MAX_LOCAL_SESSIONS);
      localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(trimmed));
    } catch (error) {
      console.warn("Failed to persist session locally", error);
    }
  }

  private restoreActiveSession() {
    try {
      const activeId = localStorage.getItem(STORAGE_KEY_ACTIVE_ID);
      if (!activeId) return;
      const found = this.getAllSessions().find((session) => session.id === activeId && !session.endedAt);
      if (found) {
        found.memory ||= { ...EMPTY_MEETING_MEMORY };
        found.transcripts = (found.transcripts || []).slice(-MAX_TURNS_PER_LOCAL_SESSION);
        this.activeSession = found;
        this.turnsSinceMemoryRefresh = 0;
        this.memoryRetryAfter = 0;
      }
    } catch {
      // Corrupt local state should never prevent the app from starting.
    }
  }
}

export const sessionManager = new SessionManager();
