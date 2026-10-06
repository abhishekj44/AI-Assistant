import type { MeetingMemory, SessionInfo, TranscriptTurn } from "./conversationTypes";
import { normalizeCallType } from "./callTypes";
import { EMPTY_MEETING_MEMORY } from "./conversationTypes";
import { SessionOutbox } from "./sessionPersistence";
import { migrateBrowserSessions } from "./browserSessionMigration";
import { transcriptStateMachine } from "./transcriptStateMachine";

export interface SavedSession {
  id: string;
  startedAt: string;
  endedAt?: string;
  transcripts: TranscriptTurn[];
  memory: MeetingMemory;
  sessionInfo?: SessionInfo;
  summary?: string;
}

export const SESSION_INFO_EVENT = "meeting-copilot-session-info";
const TAB_KEY = "session_tab_v1";
const ACTIVE_KEY = "session_active_v1";
const MAX_UI_TURNS = 600;

function emptyMemory(): MeetingMemory {
  return { ...EMPTY_MEETING_MEMORY, facts: [], decisions: [], openQuestions: [], entities: [] };
}

export class SessionManager {
  private activeSession: SavedSession | null = null;
  private outbox?: SessionOutbox;
  private ownerTabId = "";
  private writable = false;
  private initialized = false;
  private initialization?: Promise<void>;
  private generation = 0;
  private pendingHydrationTurns: TranscriptTurn[] = [];
  private totalSequence = 0;
  private memoryCoverage = 0;
  private memoryRefreshSession?: string;
  private turnsSinceMemoryRefresh = 0;
  private memoryRetryAfter = 0;
  private recentSessions: SavedSession[] = [];
  private seenTurnIds = new Set<string>();

  constructor() {
    if (typeof window !== "undefined") {
      this.setupClient();
      void this.initialize();
    }
  }

  private setupClient() {
    if (this.outbox || typeof window === "undefined") return;
    try {
      this.ownerTabId = window.sessionStorage.getItem(TAB_KEY) || crypto.randomUUID();
      window.sessionStorage.setItem(TAB_KEY, this.ownerTabId);
    } catch { this.ownerTabId = crypto.randomUUID(); }
    this.outbox = new SessionOutbox(this.ownerTabId);
    const pending = this.outbox.pending();
    const start = [...pending].reverse().find(action => action.action === "start");
    if (start && !pending.some(action => action.id === start.id && action.action === "end")) {
      this.activeSession = { id: start.id, startedAt: start.startedAt ?? new Date().toISOString(), sessionInfo: start.sessionInfo, memory: emptyMemory(), transcripts: [] };
      this.writable = true;
      for (const action of pending.filter(action => action.id === start.id)) {
        for (const turn of action.turns ?? []) {
          if (this.seenTurnIds.has(turn.id)) continue;
          this.seenTurnIds.add(turn.id);
          this.activeSession.transcripts.push(turn);
        }
        if (action.memory) this.activeSession.memory = action.memory;
      }
      this.totalSequence = this.activeSession.transcripts.length;
      this.activeSession.transcripts = this.activeSession.transcripts.slice(-MAX_UI_TURNS);
    }
  }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    if (typeof window === "undefined") return Promise.resolve();
    this.setupClient();
    const generation = this.generation;
    const initialId = this.activeSession?.id;
    this.initialization = (async () => {
      try {
        await migrateBrowserSessions(window.localStorage, async (sessions) => {
          const response = await fetch("/api/import-local", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessions }), signal: AbortSignal.timeout(15_000) });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error || "Browser session migration failed");
          return payload;
        });
        await this.outbox?.flush();
        let activeId = initialId;
        try { activeId ||= window.sessionStorage.getItem(ACTIVE_KEY) ?? undefined; } catch {}
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
          const response = await fetch(`/api/sessions?active=1${activeId ? `&id=${encodeURIComponent(activeId)}` : ""}`, { signal: controller.signal });
          if (!response.ok) throw new Error(`Session restore failed (${response.status})`);
          const payload = await response.json();
          if (generation !== this.generation || this.activeSession?.id !== initialId) return;
          const session = payload.session as (SavedSession & { ownerTabId?: string; throughSequence: number; memoryThroughSequence: number }) | null;
          if (session) {
            const localTurns = this.activeSession?.transcripts ?? [];
            const seen = new Set(session.transcripts.map(turn => turn.id));
            const uncommitted = localTurns.filter(turn => !seen.has(turn.id));
            this.activeSession = { ...session, transcripts: [...session.transcripts, ...uncommitted].slice(-MAX_UI_TURNS), memory: { ...emptyMemory(), ...session.memory } };
            this.seenTurnIds = new Set([...seen, ...uncommitted.map(turn => turn.id)]);
            this.totalSequence = session.throughSequence + uncommitted.length;
            this.memoryCoverage = session.memoryThroughSequence;
            this.writable = session.ownerTabId === this.ownerTabId;
            transcriptStateMachine.restore(this.activeSession.transcripts);
            this.broadcast();
          }
        } finally { clearTimeout(timeout); }
      } catch (error) { this.outbox?.notify("error", String(error)); }
      finally {
        this.initialized = true;
        const turns = this.pendingHydrationTurns;
        this.pendingHydrationTurns = [];
        for (const turn of turns) this.addTranscript(turn);
      }
    })();
    return this.initialization;
  }

  waitUntilReady(): Promise<void> { return this.initialize(); }
  retryPersistence() { this.outbox?.retry(); }

  startSession(info?: SessionInfo): SavedSession {
    this.setupClient();
    if (this.activeSession && this.writable) void this.endSession();
    this.generation += 1;
    this.pendingHydrationTurns = [];
    const session: SavedSession = {
      id: crypto.randomUUID(), startedAt: new Date().toISOString(), transcripts: [], memory: emptyMemory(),
      sessionInfo: info ? { ...info, callType: normalizeCallType(info.callType) } : { company: "", details: "", callType: "taking_interview" },
    };
    this.activeSession = session;
    this.writable = true;
    this.seenTurnIds.clear();
    this.totalSequence = 0;
    this.memoryCoverage = 0;
    this.turnsSinceMemoryRefresh = 0;
    this.memoryRetryAfter = 0;
    this.outbox?.enqueue({ action: "start", id: session.id, startedAt: session.startedAt, sessionInfo: session.sessionInfo }, true);
    try { window.sessionStorage.setItem(ACTIVE_KEY, session.id); } catch {}
    this.broadcast();
    return session;
  }

  addTranscript(turn: TranscriptTurn) {
    if (!turn.text.trim() || turn.isInterim) return;
    if (!this.activeSession && !this.initialized) { this.pendingHydrationTurns.push(turn); return; }
    if (!this.activeSession) this.startSession();
    if (!this.activeSession || !this.writable) {
      this.outbox?.notify("error", "Restored session is read-only; start a new session to capture turns");
      return;
    }
    if (this.seenTurnIds.has(turn.id)) return;
    this.seenTurnIds.add(turn.id);
    const finalized = { ...turn, text: turn.text.trim(), isInterim: false };
    this.activeSession.transcripts.push(finalized);
    this.activeSession.transcripts = this.activeSession.transcripts.slice(-MAX_UI_TURNS);
    this.totalSequence += 1;
    this.turnsSinceMemoryRefresh += 1;
    this.outbox?.enqueue({ action: "append", id: this.activeSession.id, turns: [finalized] });
    void this.refreshMemoryIfDue();
  }

  async endSession() {
    const session = this.activeSession;
    if (!session) return;
    this.generation += 1;
    if (this.writable) {
      session.endedAt = new Date().toISOString();
      this.outbox?.enqueue({ action: "end", id: session.id, endedAt: session.endedAt }, true);
      this.recentSessions = [session, ...this.recentSessions.filter(value => value.id !== session.id)].slice(0, 6);
    }
    this.activeSession = null;
    this.writable = false;
    this.turnsSinceMemoryRefresh = 0;
    this.memoryRetryAfter = 0;
    try { window.sessionStorage.removeItem(ACTIVE_KEY); } catch {}
    this.broadcast();
    await this.outbox?.flush();
  }

  getMemory(): MeetingMemory { return this.activeSession?.memory ?? emptyMemory(); }
  getSummary(): string { return this.getMemory().summary; }
  getRecentTurns(n = 12): TranscriptTurn[] { return this.activeSession?.transcripts.slice(-Math.max(1, Math.min(n, 50))) ?? []; }
  getSessionId(): string | undefined { return this.activeSession?.id; }
  getOwnerTabId(): string | undefined { return this.ownerTabId || undefined; }
  getStartedAt(): string | undefined { return this.activeSession?.startedAt; }
  getPendingTurns(): TranscriptTurn[] {
    const turns = this.outbox?.pending().filter(action => action.id === this.activeSession?.id)
      .flatMap(action => action.turns ?? []) ?? [];
    return [...new Map(turns.map(turn => [turn.id, turn])).values()].slice(0, 128);
  }
  getSessionInfo(): SessionInfo | undefined {
    const info = this.activeSession?.sessionInfo;
    return info ? { ...info, callType: normalizeCallType(info.callType) } : undefined;
  }
  isSessionActive(): boolean { return Boolean(this.activeSession); }
  getAllSessions(): SavedSession[] { return [...this.recentSessions]; }
  getFullTranscriptString(): string {
    return (this.activeSession?.transcripts ?? []).map(turn => `${turn.speaker === "me" ? "ME" : "INTERVIEWER"}: ${turn.text}`).join("\n");
  }

  updateSessionInfo(info: Partial<SessionInfo>) {
    if (!this.activeSession || !this.writable) return;
    const previous = this.getSessionInfo()!;
    const next = { ...previous, ...info, callType: normalizeCallType(info.callType ?? previous.callType) };
    if (this.totalSequence && next.callType !== previous.callType) {
      this.outbox?.notify("error", "Session mode is locked after the first turn");
      return;
    }
    this.activeSession.sessionInfo = next;
    this.outbox?.enqueue({ action: "start", id: this.activeSession.id, sessionInfo: next, startedAt: this.activeSession.startedAt });
    this.broadcast();
  }

  private broadcast() {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SESSION_INFO_EVENT, { detail: this.getSessionInfo() }));
  }

  private async refreshMemoryIfDue() {
    const session = this.activeSession;
    if (!session || !this.writable || this.turnsSinceMemoryRefresh < 8 || Date.now() < this.memoryRetryAfter || this.memoryRefreshSession === session.id) return;
    const sessionId = session.id;
    const generation = this.generation;
    const coverage = this.totalSequence;
    const capturedCount = this.turnsSinceMemoryRefresh;
    this.memoryRefreshSession = sessionId;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch("/api/memory", { method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ previousMemory: session.memory, turns: session.transcripts.slice(-24), sessionInfo: session.sessionInfo,
          sessionId, ownerTabId: this.ownerTabId }) });
      if (!response.ok) throw new Error(`Memory refresh failed (${response.status})`);
      const payload = await response.json();
      if (this.activeSession?.id !== sessionId || generation !== this.generation || !payload.memory || coverage <= this.memoryCoverage) return;
      this.activeSession.memory = payload.memory;
      this.memoryCoverage = coverage;
      this.turnsSinceMemoryRefresh = Math.max(0, this.turnsSinceMemoryRefresh - capturedCount);
      this.memoryRetryAfter = 0;
      this.outbox?.enqueue({ action: "memory", id: sessionId, memory: payload.memory, coveredThroughSequence: coverage });
    } catch (error) {
      if (this.activeSession?.id === sessionId && generation === this.generation) this.memoryRetryAfter = Date.now() + 30_000;
      console.warn("Meeting-memory refresh failed", error);
    } finally {
      clearTimeout(timeout);
      if (this.memoryRefreshSession === sessionId) this.memoryRefreshSession = undefined;
    }
  }
}

export const sessionManager = new SessionManager();
