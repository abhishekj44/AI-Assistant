import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { getDatabase } from "../db/connection";
import { normalizeLegacySession } from "../db/legacyMigration";
import { SessionRepository } from "./sessionRepository";

export class BrowserImportRepository {
  constructor(private readonly database: Database.Database = getDatabase()) {}

  importSessions(values: unknown[], origin: string): string[] {
    if (values.length > 1000 || JSON.stringify(values).length > 8_000_000) throw new Error("Browser session import exceeds limit");
    const snapshots = values.map(normalizeLegacySession);
    const originKey = `browser-sessions:${origin}`;
    return this.database.transaction(() => {
      const repository = new SessionRepository(this.database);
      const acknowledged: string[] = [];
      for (const [index, snapshot] of snapshots.entries()) {
        const contentHash = crypto.createHash("sha256").update(JSON.stringify(values[index])).digest("hex");
        const sourceKey = snapshot.id;
        if (!this.database.prepare("SELECT id FROM import_receipts WHERE origin=? AND source_key=? AND content_hash=?").get(originKey, sourceKey, contentHash)) {
          const existing = repository.get(snapshot.id, false);
          if (existing?.ownerTabId) throw new Error("Browser import cannot overwrite a live-owned session");
          repository.importSnapshot(snapshot);
          this.database.prepare("INSERT INTO import_receipts(id,origin,source_key,content_hash,result_json,imported_at) VALUES (?,?,?,?,?,?)")
            .run(crypto.randomUUID(), originKey, sourceKey, contentHash, JSON.stringify({ sessionId: snapshot.id, original: values[index] }), new Date().toISOString());
        }
        acknowledged.push(snapshot.id);
      }
      return acknowledged;
    }).immediate();
  }
}