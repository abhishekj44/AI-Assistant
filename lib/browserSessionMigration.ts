export async function migrateBrowserSessions(storage: Pick<Storage, "getItem" | "removeItem">, send: (sessions: unknown[]) => Promise<{ committed: boolean; sessionIds: string[] }>): Promise<void> {
  const key = "interview_sessions_v3";
  const raw = storage.getItem(key);
  if (!raw) return;
  const sessions: unknown = JSON.parse(raw);
  if (!Array.isArray(sessions) || sessions.some(session => !session || typeof session.id !== "string")) throw new Error("Legacy browser sessions are invalid; originals retained");
  const acknowledgement = await send(sessions);
  if (!acknowledgement.committed || sessions.some(session => !acknowledgement.sessionIds.includes(session.id))) throw new Error("Browser session import was not acknowledged");
  if (storage.getItem(key) === raw) {
    storage.removeItem(key);
    storage.removeItem("interview_active_session_id_v3");
  }
}