import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { migrateDatabase } from "./migrations";
import { migrateLegacyData } from "./legacyMigration";
import { ModelRunRepository } from "../repositories/modelRunRepository";
import { SessionRepository } from "../repositories/sessionRepository";

type DatabaseGlobals = typeof globalThis & {
  copilotDatabases?: Map<string, Database.Database>;
};

export function openDatabase(filename: string): Database.Database {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
  const database = new Database(filename, { timeout: 750 });
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.pragma("synchronous = FULL");
    migrateDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function getDatabase(): Database.Database {
  const filename = path.resolve(/* turbopackIgnore: true */ process.env.COPILOT_DB_PATH || path.join(process.cwd(), "data", "copilot.db"));
  const globals = globalThis as DatabaseGlobals;
  const connections = globals.copilotDatabases ||= new Map();
  const existing = connections.get(filename);
  if (existing?.open) return existing;
  const database = openDatabase(filename);
  migrateLegacyData(database, process.env.COPILOT_LEGACY_ROOT || process.cwd());
  new ModelRunRepository(database).recoverInterruptedRuns();
  new SessionRepository(database).recoverInterruptedSummaries();
  connections.set(filename, database);
  return database;
}