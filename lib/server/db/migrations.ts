import crypto from "node:crypto";
import type Database from "better-sqlite3";

export const DEFAULT_KNOWLEDGE_BASE_ID = "personal-knowledge";

const migrations = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
      CREATE TABLE knowledge_bases (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('PERSONAL', 'JOB', 'REFERENCE')),
        name TEXT NOT NULL,
        company TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'ARCHIVED')),
        baseline_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(baseline_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK(mode IN ('INTERVIEWER', 'INTERVIEWEE', 'MEETING')),
        variant TEXT NOT NULL DEFAULT 'standard' CHECK(variant IN ('standard', 'course_admission')),
        company TEXT NOT NULL DEFAULT '',
        details TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE', 'ENDING', 'ENDED', 'ABANDONED')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        summary_text TEXT NOT NULL DEFAULT '',
        summary_status TEXT NOT NULL DEFAULT 'NONE' CHECK(summary_status IN ('NONE', 'PENDING', 'READY', 'FAILED')),
        summary_through_sequence INTEGER NOT NULL DEFAULT 0,
        summary_error TEXT,
        memory_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(memory_json)),
        memory_through_sequence INTEGER NOT NULL DEFAULT 0,
        next_sequence INTEGER NOT NULL DEFAULT 0,
        owner_tab_id TEXT,
        lease_expires_at INTEGER,
        accept_late_until INTEGER,
        job_description TEXT NOT NULL DEFAULT '' CHECK(length(job_description) <= 12000),
        candidate_profile TEXT NOT NULL DEFAULT '' CHECK(length(candidate_profile) <= 12000)
      );
      CREATE INDEX sessions_history ON sessions(status, started_at DESC);
      CREATE TABLE session_knowledge_bases (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE RESTRICT,
        PRIMARY KEY(session_id, knowledge_base_id)
      );
      CREATE INDEX session_bases_base ON session_knowledge_bases(knowledge_base_id);
      CREATE TABLE transcript_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        client_turn_id TEXT NOT NULL,
        sequence_no INTEGER NOT NULL CHECK(sequence_no > 0),
        speaker TEXT NOT NULL CHECK(speaker IN ('LOCAL', 'REMOTE')),
        text TEXT NOT NULL CHECK(length(trim(text)) > 0),
        captured_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        audio_start REAL,
        audio_end REAL,
        confidence REAL CHECK(confidence IS NULL OR confidence BETWEEN 0 AND 1),
        metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
        UNIQUE(session_id, client_turn_id),
        UNIQUE(session_id, sequence_no)
      );
      CREATE TABLE knowledge_documents (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
        document_type TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        original_bytes BLOB,
        mime_type TEXT,
        extracted_text TEXT NOT NULL DEFAULT '',
        source_json TEXT NOT NULL CHECK(json_valid(source_json)),
        created_at TEXT NOT NULL,
        UNIQUE(id, knowledge_base_id)
      );
      CREATE INDEX documents_base ON knowledge_documents(knowledge_base_id);
      CREATE TABLE prompts (
        template_key TEXT PRIMARY KEY,
        purpose TEXT NOT NULL CHECK(purpose IN ('ANSWER', 'SUMMARY', 'MEMORY', 'EXTRACTION', 'CHAT')),
        mode TEXT CHECK(mode IS NULL OR mode IN ('INTERVIEWER', 'INTERVIEWEE', 'MEETING')),
        variant TEXT NOT NULL DEFAULT 'standard' CHECK(variant IN ('standard', 'course_admission')),
        system_template TEXT NOT NULL,
        user_template TEXT NOT NULL DEFAULT '',
        parameters_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(parameters_json)),
        customized INTEGER NOT NULL DEFAULT 0 CHECK(customized IN (0, 1)),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        mode_snapshot TEXT CHECK(mode_snapshot IS NULL OR mode_snapshot IN ('INTERVIEWER', 'INTERVIEWEE', 'MEETING')),
        primary_ask TEXT NOT NULL,
        scenario_context TEXT NOT NULL DEFAULT '',
        retrieval_query TEXT NOT NULL DEFAULT '',
        bundle_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(bundle_json)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX questions_session ON questions(session_id, created_at DESC);
      CREATE TABLE model_requests (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        question_id TEXT REFERENCES questions(id) ON DELETE SET NULL,
        prompt_key TEXT,
        purpose TEXT NOT NULL,
        mode_snapshot TEXT CHECK(mode_snapshot IS NULL OR mode_snapshot IN ('INTERVIEWER', 'INTERVIEWEE', 'MEETING')),
        variant_snapshot TEXT NOT NULL DEFAULT 'standard',
        rendered_system_text TEXT NOT NULL DEFAULT '',
        rendered_user_text TEXT NOT NULL DEFAULT '',
        context_snapshot_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(context_snapshot_json)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX requests_session ON model_requests(session_id, created_at DESC);
      CREATE INDEX requests_question ON model_requests(question_id);
      CREATE TABLE model_runs (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES model_requests(id) ON DELETE CASCADE,
        slot TEXT NOT NULL CHECK(slot IN ('SINGLE', 'A', 'B')),
        attempt_no INTEGER NOT NULL DEFAULT 1,
        provider TEXT,
        model TEXT,
        status TEXT NOT NULL CHECK(status IN ('PENDING', 'RUNNING', 'COMPLETED', 'INTERRUPTED', 'FAILED')),
        output_text TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        metrics_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metrics_json)),
        error TEXT,
        saved_at TEXT,
        display_tag TEXT NOT NULL DEFAULT 'Interview Answer',
        feedback TEXT CHECK(feedback IS NULL OR feedback IN ('GOOD', 'POOR')),
        feedback_at TEXT,
        owner_pid INTEGER,
        checkpoint_at TEXT,
        UNIQUE(request_id, slot, attempt_no)
      );
      CREATE INDEX runs_history ON model_runs(started_at DESC, id);
      CREATE INDEX runs_saved ON model_runs(saved_at DESC) WHERE saved_at IS NOT NULL;
      CREATE INDEX runs_owner ON model_runs(owner_pid, status);
      CREATE TABLE knowledge_entries (
        id TEXT PRIMARY KEY,
        knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE RESTRICT,
        document_id TEXT,
        kind TEXT NOT NULL CHECK(kind IN ('PROFILE', 'EXPERIENCE', 'PROJECT', 'SKILL', 'ACHIEVEMENT', 'FACT', 'TARGET_ROLE', 'NOTE', 'QA')),
        title TEXT NOT NULL,
        question TEXT,
        content TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data_json)),
        tags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags_json)),
        review_state TEXT NOT NULL DEFAULT 'APPROVED' CHECK(review_state IN ('EXTRACTED', 'APPROVED', 'REJECTED', 'RETIRED')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        priority INTEGER NOT NULL DEFAULT 5 CHECK(priority BETWEEN 0 AND 10),
        origin_run_id TEXT REFERENCES model_runs(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(document_id, knowledge_base_id) REFERENCES knowledge_documents(id, knowledge_base_id) ON DELETE CASCADE,
        UNIQUE(knowledge_base_id, origin_run_id),
        CHECK(kind != 'QA' OR (length(trim(question)) > 0 AND length(trim(content)) > 0))
      );
      CREATE INDEX entries_base ON knowledge_entries(knowledge_base_id, kind, enabled, review_state);
      CREATE INDEX entries_document ON knowledge_entries(document_id);
      CREATE INDEX entries_origin ON knowledge_entries(origin_run_id);
      CREATE TABLE knowledge_variants (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
        alternate_question TEXT NOT NULL,
        normalized_question TEXT NOT NULL,
        position INTEGER NOT NULL,
        UNIQUE(entry_id, normalized_question),
        UNIQUE(entry_id, position)
      );
      CREATE TABLE retrieval_items (
        id INTEGER PRIMARY KEY,
        document_id TEXT REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        entry_id TEXT REFERENCES knowledge_entries(id) ON DELETE CASCADE,
        question_id TEXT REFERENCES questions(id) ON DELETE CASCADE,
        summary_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
        transcript_turn_id TEXT REFERENCES transcript_turns(id) ON DELETE CASCADE,
        chunk_index INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        search_terms TEXT NOT NULL DEFAULT '',
        token_estimate INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT NOT NULL,
        CHECK((document_id IS NOT NULL) + (entry_id IS NOT NULL) + (question_id IS NOT NULL) + (summary_session_id IS NOT NULL) + (transcript_turn_id IS NOT NULL) = 1)
      );
      CREATE INDEX retrieval_document ON retrieval_items(document_id);
      CREATE INDEX retrieval_entry ON retrieval_items(entry_id);
      CREATE INDEX retrieval_question ON retrieval_items(question_id);
      CREATE INDEX retrieval_summary ON retrieval_items(summary_session_id);
      CREATE INDEX retrieval_turn ON retrieval_items(transcript_turn_id);
      CREATE VIRTUAL TABLE retrieval_fts USING fts5(title, body, search_terms, content='retrieval_items', content_rowid='id');
      CREATE TRIGGER retrieval_insert AFTER INSERT ON retrieval_items BEGIN
        INSERT INTO retrieval_fts(rowid, title, body, search_terms) VALUES (new.id, new.title, new.body, new.search_terms);
      END;
      CREATE TRIGGER retrieval_delete AFTER DELETE ON retrieval_items BEGIN
        INSERT INTO retrieval_fts(retrieval_fts, rowid, title, body, search_terms) VALUES ('delete', old.id, old.title, old.body, old.search_terms);
      END;
      CREATE TRIGGER retrieval_update AFTER UPDATE ON retrieval_items BEGIN
        INSERT INTO retrieval_fts(retrieval_fts, rowid, title, body, search_terms) VALUES ('delete', old.id, old.title, old.body, old.search_terms);
        INSERT INTO retrieval_fts(rowid, title, body, search_terms) VALUES (new.id, new.title, new.body, new.search_terms);
      END;
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL CHECK(json_valid(value_json)),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE chat_threads (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        title TEXT NOT NULL DEFAULT 'Chat',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX chat_threads_updated ON chat_threads(updated_at DESC);
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('USER', 'ASSISTANT')),
        content TEXT NOT NULL,
        run_id TEXT REFERENCES model_runs(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX chat_messages_thread ON chat_messages(thread_id, created_at, id);
      CREATE INDEX chat_messages_run ON chat_messages(run_id);
      CREATE TABLE import_receipts (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        source_key TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json)),
        imported_at TEXT NOT NULL,
        UNIQUE(origin, source_key, content_hash)
      );
    `,
  },
  {
    version: 2,
    name: "giving_interview_role",
    sql: `
      ALTER TABLE sessions ADD COLUMN job_title TEXT NOT NULL DEFAULT '' CHECK(length(job_title) <= 200);
      ALTER TABLE sessions ADD COLUMN seniority TEXT NOT NULL DEFAULT '' CHECK(length(seniority) <= 100);
    `,
  },
];

export function migrateDatabase(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = database.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number; checksum: string }>;
  const checksum = (sql: string) => crypto.createHash("sha256").update(sql).digest("hex");
  for (const migration of migrations) {
    const previous = applied.find((entry) => entry.version === migration.version);
    if (previous && previous.checksum !== checksum(migration.sql)) {
      throw new Error(`Migration ${migration.version} checksum mismatch: this database was created by a different schema version (for example a pre-release build) and cannot be upgraded in place. Move the database file and its -wal and -shm files aside to start fresh, or restore a matching backup.`);
    }
  }
  if (applied.some((entry) => entry.version > migrations.at(-1)!.version)) {
    throw new Error("The database was created by a newer application version");
  }
  for (const migration of migrations) {
    if (applied.some((entry) => entry.version === migration.version)) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)")
        .run(migration.version, migration.name, checksum(migration.sql), new Date().toISOString());
    }).immediate();
  }
  const now = new Date().toISOString();
  database.prepare("INSERT OR IGNORE INTO knowledge_bases(id, kind, name, created_at, updated_at) VALUES (?, 'PERSONAL', 'Candidate Knowledge', ?, ?)")
    .run(DEFAULT_KNOWLEDGE_BASE_ID, now, now);
}