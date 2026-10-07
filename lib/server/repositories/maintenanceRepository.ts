import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import Database from "better-sqlite3";
import { getDatabase } from "../db/connection";
import { LEGACY_IMPORT_STATUS_KEY, type LegacyMigrationReport } from "../db/legacyMigration";

const BACKUP_ID = /^backup-\d{8}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db$/;
const COUNT_TABLES = ["knowledge_bases", "sessions", "transcript_turns", "knowledge_documents", "knowledge_entries", "knowledge_variants", "questions", "model_requests", "model_runs", "retrieval_items", "chat_threads", "chat_messages", "import_receipts"] as const;
export class MaintenanceError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export class MaintenanceRepository {
  constructor(private readonly suppliedDatabase?: Database.Database, private readonly root?: string) {}
  private get database() { return this.suppliedDatabase ?? getDatabase(); }

  stats() {
    const database = this.database;
    const integrity = database.pragma("quick_check", { simple: true }) === "ok";
    const foreignKeyViolations = database.pragma("foreign_key_check") as unknown[];
    let ftsIntegrity = true;
    try { database.exec("INSERT INTO retrieval_fts(retrieval_fts,rank) VALUES ('integrity-check',1)"); } catch { ftsIntegrity = false; }
    const counts = Object.fromEntries(COUNT_TABLES.map(table => [table, (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count]));
    const row = database.prepare("SELECT value_json FROM app_settings WHERE key=?").get(LEGACY_IMPORT_STATUS_KEY) as { value_json: string } | undefined;
    const report = row ? JSON.parse(row.value_json) as LegacyMigrationReport : null;
    const legacyImport = report ? { importerVersion: report.importerVersion, checkedAt: report.checkedAt,
      sources: report.sources.map(source => ({ sourceKey: source.sourceKey, status: source.status, count: source.count, warnings: source.warnings, error: source.error })) } : null;
    const size = (filename: string) => fs.existsSync(filename) ? fs.statSync(filename).size : 0;
    return {
      healthy: integrity && foreignKeyViolations.length === 0 && ftsIntegrity,
      integrity, foreignKeyViolations: foreignKeyViolations.length, ftsIntegrity,
      schema: database.prepare("SELECT version,name,applied_at FROM schema_migrations ORDER BY version").all(),
      counts, legacyImport,
      storage: { path: database.name, journalMode: database.pragma("journal_mode", { simple: true }),
        databaseBytes: size(database.name), walBytes: size(`${database.name}-wal`), sharedMemoryBytes: size(`${database.name}-shm`),
        pageCount: database.pragma("page_count", { simple: true }), pageSize: database.pragma("page_size", { simple: true }), freePages: database.pragma("freelist_count", { simple: true }) },
    };
  }

  rebuildSearchIndex() {
    this.database.transaction(() => {
      this.database.exec("INSERT INTO retrieval_fts(retrieval_fts) VALUES ('rebuild')");
      this.database.exec("INSERT INTO retrieval_fts(retrieval_fts,rank) VALUES ('integrity-check',1)");
    }).immediate();
    return { rebuilt: true, scope: "retrieval_fts", items: (this.database.prepare("SELECT count(*) AS count FROM retrieval_items").get() as { count: number }).count };
  }

  private backupDirectory(create = false) {
    const data = path.join(path.resolve(/* turbopackIgnore: true */ this.root ?? process.cwd()), "data");
    const directory = path.join(data, "backups");
    for (const candidate of [data, directory]) {
      if (fs.existsSync(/* turbopackIgnore: true */ candidate) && fs.lstatSync(/* turbopackIgnore: true */ candidate).isSymbolicLink()) throw new MaintenanceError("Backup directories cannot be symbolic links");
    }
    if (create) fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  private backupPath(id: string) {
    if (!BACKUP_ID.test(id)) throw new MaintenanceError("Invalid local backup id");
    const filename = path.join(this.backupDirectory(), id);
    if (!fs.existsSync(filename)) throw new MaintenanceError("Backup not found", 404);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new MaintenanceError("Backup must be a regular local file");
    return filename;
  }

  async backup() {
    const id = `backup-${new Date().toISOString().replace(/[-:.]/g, "")}-${crypto.randomUUID()}.db`;
    const filename = path.join(this.backupDirectory(true), id);
    try {
      await this.database.backup(filename);
      this.validateBackup(id);
      return { id, bytes: fs.statSync(filename).size, createdAt: new Date().toISOString() };
    } catch (error) {
      fs.rmSync(filename, { force: true });
      throw error;
    }
  }

  validateBackup(id: string) {
    const filename = this.backupPath(id);
    const backup = new Database(filename, { readonly: true, fileMustExist: true });
    try {
      if (backup.pragma("quick_check", { simple: true }) !== "ok" || (backup.pragma("foreign_key_check") as unknown[]).length) throw new MaintenanceError("Backup integrity check failed");
      const schema = backup.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all();
      const current = this.database.prepare("SELECT version,checksum FROM schema_migrations ORDER BY version").all();
      if (JSON.stringify(schema) !== JSON.stringify(current)) throw new MaintenanceError("Backup schema differs from the running application; use a matching application version");
      for (const table of COUNT_TABLES) backup.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
      return { id, valid: true, bytes: fs.statSync(filename).size };
    } catch (error) {
      if (error instanceof MaintenanceError) throw error;
      throw new MaintenanceError("Backup is not a compatible application database");
    } finally { backup.close(); }
  }

  exportBackup(id: string) {
    const validation = this.validateBackup(id);
    return { ...validation, stream: Readable.toWeb(fs.createReadStream(this.backupPath(id))) as ReadableStream<Uint8Array> };
  }

  restoreInstructions(id: string) {
    const validation = this.validateBackup(id);
    return { ...validation, restored: false, requiresRestart: true,
      instructions: [
        "Download this validated backup using GET /api/database?backup=" + id,
        "Stop the application and every process using its database so all SQLite connections are closed.",
        "Keep a recovery copy of the current database and its -wal and -shm files together before changing anything.",
        "Replace the configured database file with the downloaded backup, and remove the old -wal and -shm files from the active database location only while all connections are closed.",
        "Restart the matching application version; normal startup verifies schema migrations. Legacy source files imported after this backup may be imported again, so retain their matching receipts or reconcile those files before restart.",
      ] };
  }
}