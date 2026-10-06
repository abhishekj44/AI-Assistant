import type { MeetingMemory, SessionInfo, TranscriptTurn } from "./conversationTypes";

export const SESSION_PERSISTENCE_EVENT = "meeting-copilot-persistence";
export const SESSION_OUTBOX_KEY = "session_outbox_v1";
export interface SessionAction {
  action: "start" | "append" | "end" | "memory";
  id: string;
  ownerTabId: string;
  startedAt?: string;
  endedAt?: string;
  sessionInfo?: SessionInfo;
  turns?: TranscriptTurn[];
  memory?: MeetingMemory;
  coveredThroughSequence?: number;
}
interface PendingAction { key: string; body: SessionAction; attempts: number; }
export interface SessionAcknowledgement {
  success: boolean;
  committedThroughSequence: number;
  session: { id: string; status: string; ownerTabId?: string };
}

export class SessionOutbox {
  private items: PendingAction[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private sendingKey?: string;
  private blockedSessions = new Set<string>();
  private readonly volatileItems = new Map<string, PendingAction>();
  constructor(public readonly ownerTabId: string) {
    this.items = this.read();
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.retry());
      window.addEventListener("pagehide", () => this.pagehide());
    }
  }

  notify(status: "pending" | "saved" | "error", error?: string) {
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(SESSION_PERSISTENCE_EVENT, { detail: { status, error, pending: this.items.length } }));
  }

  private read(): PendingAction[] {
    if (typeof window === "undefined") return this.items;
    try {
      const raw = window.localStorage.getItem(SESSION_OUTBOX_KEY);
      if (!raw) return [];
      const items: unknown = JSON.parse(raw);
      if (!Array.isArray(items) || items.length > 4096) throw new Error("Invalid session outbox");
      if (!items.every(item => item && typeof item.key === "string" && typeof item.body?.id === "string" && typeof item.body?.ownerTabId === "string" && ["start", "append", "end", "memory"].includes(item.body.action) && Number.isInteger(item.attempts))) throw new Error("Invalid session outbox entries");
      return items;
    } catch (error) {
      this.notify("error", `Cannot read session outbox: ${String(error)}`);
      return this.items;
    }
  }

  private persist(removeKey?: string) {
    const merged = new Map(this.read().map(item => [item.key, item]));
    for (const item of this.items) merged.set(item.key, item);
    if (removeKey) merged.delete(removeKey);
    this.items = [...merged.values()];
    if (typeof window === "undefined") return;
    try {
      const serialized = JSON.stringify(this.items);
      if (serialized.length > 2_000_000 || this.items.length > 4096) throw new Error("Session outbox capacity exceeded; pending actions remain in memory");
      window.localStorage.setItem(SESSION_OUTBOX_KEY, serialized);
      this.volatileItems.clear();
    } catch (error) {
      for (const item of this.items) this.volatileItems.set(item.key, item);
      this.notify("error", `Session retry storage unavailable: ${String(error)}`);
    }
  }

  pending(): SessionAction[] { return this.items.filter(item => item.body.ownerTabId === this.ownerTabId).map(item => item.body); }

  enqueue(body: Omit<SessionAction, "ownerTabId">, immediate = false) {
    const last = this.items.at(-1);
    if (body.action === "append" && last?.body.action === "append" && last.body.id === body.id && last.body.ownerTabId === this.ownerTabId && last.key !== this.sendingKey && (last.body.turns?.length ?? 0) < 64 && JSON.stringify(last.body).length + JSON.stringify(body).length < 48_000) {
      const existing = new Set(last.body.turns?.map(turn => turn.id));
      last.body.turns = [...(last.body.turns ?? []), ...(body.turns ?? []).filter(turn => !existing.has(turn.id))];
    } else {
      this.items.push({ key: crypto.randomUUID(), body: { ...body, ownerTabId: this.ownerTabId }, attempts: 0 });
    }
    this.persist();
    this.notify("pending");
    this.schedule(immediate ? 0 : 750);
  }

  private schedule(delay: number) {
    if (typeof window === "undefined") return;
    if (this.timer && delay > 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, delay);
  }

  retry() {
    this.blockedSessions.clear();
    for (const item of this.items) item.attempts = 0;
    this.persist();
    void this.flush();
  }

  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.inFlight = this.drain().finally(() => { this.inFlight = undefined; this.sendingKey = undefined; });
    return this.inFlight;
  }

  private async drain() {
    let processed = 0;
    while (processed < 64) {
      const item = this.items.find(candidate => candidate.body.ownerTabId === this.ownerTabId && !this.blockedSessions.has(candidate.body.id));
      if (!item) return;
      if (item.attempts >= 6) { this.blockedSessions.add(item.body.id); continue; }
      this.sendingKey = item.key;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(item.body), signal: controller.signal });
        if (!response.ok) {
          if ([400, 404, 409, 413].includes(response.status)) this.blockedSessions.add(item.body.id);
          throw new Error(`Session save rejected (${response.status})`);
        }
        const payload = await response.json() as SessionAcknowledgement;
        if (payload.success !== true || payload.session?.id !== item.body.id || !Number.isSafeInteger(payload.committedThroughSequence)) throw new Error("Session save was not acknowledged");
        this.items = this.items.filter(candidate => candidate.key !== item.key);
        this.volatileItems.delete(item.key);
        this.persist(item.key);
        this.notify(this.items.length ? "pending" : "saved");
        processed += 1;
      } catch (error) {
        item.attempts += 1;
        this.persist();
        this.notify("error", String(error));
        if (this.blockedSessions.has(item.body.id)) continue;
        if (item.attempts < 6) this.schedule(Math.min(30_000, 1000 * 2 ** item.attempts));
        return;
      } finally { clearTimeout(timeout); }
    }
    if (this.items.some(item => item.body.ownerTabId === this.ownerTabId && !this.blockedSessions.has(item.body.id))) this.schedule(750);
  }

  private pagehide() {
    const first = this.items.find(item => item.body.ownerTabId === this.ownerTabId && !this.blockedSessions.has(item.body.id));
    if (!first) return;
    const body = JSON.stringify(first.body);
    if (body.length > 48_000) return;
    void fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => undefined);
  }
}