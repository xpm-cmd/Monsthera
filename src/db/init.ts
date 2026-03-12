import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import * as schema from "./schema.js";

export interface DbInitOptions {
  repoPath: string;
  agoraDir: string;
  dbName: string;
}

export interface DbInitResult {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: DatabaseType;
}

export function initDatabase(opts: DbInitOptions): DbInitResult {
  const dirPath = join(opts.repoPath, opts.agoraDir);
  mkdirSync(dirPath, { recursive: true });

  const dbPath = join(dirPath, opts.dbName);
  const sqlite = new Database(dbPath);

  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  createTables(sqlite);
  runMigrations(sqlite);

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

function createTables(sqlite: Database.Database): void {
  const statements = [
    `CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS index_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      db_indexed_commit TEXT,
      zoekt_indexed_commit TEXT,
      indexed_at TEXT,
      last_success TEXT,
      last_error TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      path TEXT NOT NULL,
      language TEXT,
      content_hash TEXT,
      summary TEXT,
      symbols_json TEXT,
      has_secrets INTEGER DEFAULT 0,
      secret_line_ranges TEXT,
      indexed_at TEXT,
      commit_sha TEXT,
      embedding BLOB
    )`,
    `CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file_id INTEGER NOT NULL REFERENCES files(id),
      target_path TEXT NOT NULL,
      kind TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      permissions_json TEXT NOT NULL,
      is_built_in INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'unknown',
      provider TEXT,
      model TEXT,
      model_family TEXT,
      model_version TEXT,
      identity_source TEXT,
      role_id TEXT NOT NULL DEFAULT 'observer',
      trust_tier TEXT NOT NULL DEFAULT 'B',
      registered_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      state TEXT NOT NULL DEFAULT 'active',
      connected_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      claimed_files_json TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      type TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      metadata_json TEXT,
      linked_paths_json TEXT,
      agent_id TEXT,
      session_id TEXT,
      commit_sha TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS patches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      proposal_id TEXT NOT NULL UNIQUE,
      base_commit TEXT NOT NULL,
      bundle_id TEXT,
      state TEXT NOT NULL,
      diff TEXT NOT NULL,
      message TEXT NOT NULL,
      touched_paths_json TEXT,
      dry_run_result_json TEXT,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      committed_sha TEXT,
      ticket_id INTEGER REFERENCES tickets(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      ticket_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'backlog',
      severity TEXT NOT NULL DEFAULT 'medium',
      priority INTEGER NOT NULL DEFAULT 5,
      tags_json TEXT,
      affected_paths_json TEXT,
      acceptance_criteria TEXT,
      creator_agent_id TEXT NOT NULL,
      creator_session_id TEXT NOT NULL,
      assignee_agent_id TEXT,
      resolved_by_agent_id TEXT,
      commit_sha TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      from_status TEXT,
      to_status TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      comment TEXT,
      timestamp TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      to_ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      relation_type TEXT NOT NULL,
      created_by_agent_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS coordination_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      message_id TEXT NOT NULL UNIQUE,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS dashboard_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      event_type TEXT NOT NULL,
      data_json TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS event_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      duration_ms REAL NOT NULL,
      status TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      commit_scope TEXT NOT NULL,
      payload_size_in INTEGER NOT NULL,
      payload_size_out INTEGER NOT NULL,
      input_hash TEXT NOT NULL,
      output_hash TEXT NOT NULL,
      redacted_summary TEXT NOT NULL,
      error_code TEXT,
      error_detail TEXT,
      denial_reason TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      scope TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      agent_id TEXT,
      session_id TEXT,
      embedding BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS debug_payloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL REFERENCES event_logs(event_id),
      raw_input TEXT,
      raw_output TEXT,
      expires_at TEXT NOT NULL
    )`,
  ];

  for (const stmt of statements) {
    sqlite.prepare(stmt).run();
  }
}

export interface GlobalDbResult {
  globalDb: BetterSQLite3Database<typeof schema>;
  globalSqlite: DatabaseType;
}

export function initGlobalDatabase(): GlobalDbResult {
  const globalDir = join(homedir(), ".agora");
  mkdirSync(globalDir, { recursive: true });

  const dbPath = join(globalDir, "knowledge.db");
  const globalSqlite = new Database(dbPath);

  globalSqlite.pragma("journal_mode = WAL");

  globalSqlite.prepare(`CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags_json TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    agent_id TEXT,
    session_id TEXT,
    embedding BLOB,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();

  const globalDb = drizzle(globalSqlite, { schema });
  return { globalDb, globalSqlite };
}

function runMigrations(sqlite: Database.Database): void {
  // Migration 1: Add embedding column to files table (semantic search)
  try {
    sqlite.prepare("SELECT embedding FROM files LIMIT 0").get();
  } catch {
    sqlite.prepare("ALTER TABLE files ADD COLUMN embedding BLOB").run();
  }

  // Migration 2: Add ticket_id column to patches table
  // Note: ALTER TABLE in SQLite adds the column but NOT the FK constraint.
  // Integrity is application-level for migrated DBs, physical for new installs.
  try {
    sqlite.prepare("SELECT ticket_id FROM patches LIMIT 0").get();
  } catch {
    sqlite.prepare("ALTER TABLE patches ADD COLUMN ticket_id INTEGER").run();
  }

  // Migration 3: Add error_code column to event_logs
  try {
    sqlite.prepare("SELECT error_code FROM event_logs LIMIT 0").get();
  } catch {
    sqlite.prepare("ALTER TABLE event_logs ADD COLUMN error_code TEXT").run();
  }

  // Migration 4: Add error_detail column to event_logs
  try {
    sqlite.prepare("SELECT error_detail FROM event_logs LIMIT 0").get();
  } catch {
    sqlite.prepare("ALTER TABLE event_logs ADD COLUMN error_detail TEXT").run();
  }

  // Migration 5-9: Add normalized agent identity columns
  for (const [column, definition] of [
    ["provider", "TEXT"],
    ["model", "TEXT"],
    ["model_family", "TEXT"],
    ["model_version", "TEXT"],
    ["identity_source", "TEXT"],
  ] as const) {
    try {
      sqlite.prepare(`SELECT ${column} FROM agents LIMIT 0`).get();
    } catch {
      sqlite.prepare(`ALTER TABLE agents ADD COLUMN ${column} ${definition}`).run();
    }
  }
}
