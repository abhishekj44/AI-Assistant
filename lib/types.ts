export enum FLAGS {
  COPILOT = "copilot",
  SUMMERIZER = "summerizer",
}

export interface HistoryData {
  id?: string;
  createdAt: string;
  data: string;
  tag: string;
  question?: string;
}

export interface ClientHistoryEntry {
  id: string;
  createdAt: string;
  answer: string;
  question?: string;
  tag: string;
  status?: string;
}

export function mapSavedHistory(entry: ClientHistoryEntry): HistoryData {
  return { id: entry.id, createdAt: entry.createdAt, data: entry.answer, question: entry.question, tag: entry.tag };
}

export function isCompletedOutput(answer: string, done: boolean, failed: boolean, completion: { status?: string; completed?: boolean } = {}): boolean {
  return done && !failed && Boolean(answer.trim()) && completion.completed !== false
    && (completion.status === undefined || completion.status === "COMPLETED");
}

export function legacyHistoryId(entry: HistoryData, index: number): string {
  if (entry.id) return entry.id;
  const identity = JSON.stringify([entry.createdAt, entry.tag, entry.question || "", entry.data, index]);
  let hash = 2166136261;
  for (const character of identity) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `legacy-history-${index}-${(hash >>> 0).toString(16)}`;
}

export async function migrateSavedHistory(storage: Pick<Storage, "getItem" | "removeItem">, acknowledge: (entry: HistoryData & { id: string }) => Promise<void>): Promise<void> {
  const raw = storage.getItem("savedData");
  if (raw === null) return;
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry.data !== "string" || typeof entry.createdAt !== "string" || typeof entry.tag !== "string")) {
    throw new Error("Browser history is invalid; the original data has been retained.");
  }
  for (const [index, entry] of (entries as HistoryData[]).entries()) {
    await acknowledge({ ...entry, id: legacyHistoryId(entry, index) });
  }
  if (storage.getItem("savedData") === raw) storage.removeItem("savedData");
}

export interface ExtractedQuestion {
  question: string;
  context: string;
  confidence: number;
}

