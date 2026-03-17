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
    `CREATE TABLE IF NOT EXISTS code_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id),
      chunk_index INTEGER NOT NULL,
      symbol_name TEXT,
      kind TEXT,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content_hash TEXT,
      embedding BLOB
    )`,
    `CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file_id INTEGER NOT NULL REFERENCES files(id),
      target_path TEXT NOT NULL,
      kind TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS symbol_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file_id INTEGER NOT NULL REFERENCES files(id),
      source_symbol_name TEXT,
      target_name TEXT NOT NULL,
      reference_kind TEXT NOT NULL,
      line INTEGER NOT NULL
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
      claimed_files_json TEXT,
      worktree_path TEXT,
      worktree_branch TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS commit_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      ticket_id TEXT,
      acquired_at TEXT NOT NULL,
      released_at TEXT
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
      resolution_commits_json TEXT,
      required_roles_json TEXT,
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
    `CREATE TABLE IF NOT EXISTS review_verdicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      specialization TEXT NOT NULL,
      verdict TEXT NOT NULL,
      reasoning TEXT,
      created_at TEXT NOT NULL,
      superseded_by INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS council_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      agent_id TEXT NOT NULL,
      specialization TEXT NOT NULL,
      assigned_by_agent_id TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      UNIQUE(ticket_id, specialization)
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
    `CREATE TABLE IF NOT EXISTS protected_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      path_pattern TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(repo_id, path_pattern)
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
  globalSqlite.pragma("foreign_keys = ON");
  globalSqlite.pragma("busy_timeout = 5000");
  globalSqlite.pragma("synchronous = NORMAL");

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

  // Migration 5: Create protected_artifacts table
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS protected_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    path_pattern TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(repo_id, path_pattern)
  )`).run();

  // Migration 6-10: Add normalized agent identity columns
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

  // Migration 11: Create/upgrade review_verdicts table for append-only verdict history
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS review_verdicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id),
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    specialization TEXT NOT NULL,
    verdict TEXT NOT NULL,
    reasoning TEXT,
    created_at TEXT NOT NULL,
    superseded_by INTEGER
  )`).run();
  const reviewVerdictsSql = sqlite
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'review_verdicts'")
    .get() as { sql: string | null } | undefined;
  const reviewVerdictsNeedsRebuild = (reviewVerdictsSql?.sql?.includes("UNIQUE(ticket_id, specialization)") ?? false)
    || !(sqlite.prepare("PRAGMA table_info(review_verdicts)").all() as Array<{ name: string }>)
      .some((column) => column.name === "superseded_by");
  if (reviewVerdictsNeedsRebuild) {
    sqlite.prepare("DROP INDEX IF EXISTS idx_review_verdicts_ticket_specialization").run();
    sqlite.prepare("DROP INDEX IF EXISTS idx_review_verdicts_ticket_specialization_history").run();
    sqlite.prepare(`CREATE TABLE review_verdicts_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id),
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      specialization TEXT NOT NULL,
      verdict TEXT NOT NULL,
      reasoning TEXT,
      created_at TEXT NOT NULL,
      superseded_by INTEGER
    )`).run();
    sqlite.prepare(`
      INSERT INTO review_verdicts_new (id, ticket_id, agent_id, session_id, specialization, verdict, reasoning, created_at, superseded_by)
      SELECT id, ticket_id, agent_id, session_id, specialization, verdict, reasoning, created_at, NULL
      FROM review_verdicts
    `).run();
    sqlite.prepare("BEGIN IMMEDIATE").run();
    try {
      sqlite.prepare("DROP TABLE review_verdicts").run();
      sqlite.prepare("ALTER TABLE review_verdicts_new RENAME TO review_verdicts").run();
      sqlite.prepare("COMMIT").run();
    } catch (err) {
      sqlite.prepare("ROLLBACK").run();
      throw err;
    }
  }
  sqlite.prepare("DROP INDEX IF EXISTS idx_review_verdicts_ticket_specialization").run();
  sqlite.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_review_verdicts_ticket_specialization ON review_verdicts(ticket_id, specialization) WHERE superseded_by IS NULL",
  ).run();
  sqlite.prepare(
    "CREATE INDEX IF NOT EXISTS idx_review_verdicts_ticket_specialization_history ON review_verdicts(ticket_id, specialization, id)",
  ).run();

  // Migration 12: Create council_assignments table
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS council_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id),
    agent_id TEXT NOT NULL,
    specialization TEXT NOT NULL,
    assigned_by_agent_id TEXT NOT NULL,
    assigned_at TEXT NOT NULL,
    UNIQUE(ticket_id, specialization)
  )`).run();
  sqlite.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_council_assignments_ticket_specialization ON council_assignments(ticket_id, specialization)",
  ).run();
  sqlite.prepare(
    "CREATE INDEX IF NOT EXISTS idx_council_assignments_ticket_agent ON council_assignments(ticket_id, agent_id)",
  ).run();

  // Migration 13: Add FK lookup indexes for ticket knowledge capture reads
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_ticket_history_ticket_id ON ticket_history(ticket_id)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_ticket_comments_ticket_id ON ticket_comments(ticket_id)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_patches_ticket_id ON patches(ticket_id)").run();

  // Migration 14: Add multi-commit resolution traceability for umbrella tickets
  try {
    sqlite.prepare("SELECT resolution_commits_json FROM tickets LIMIT 0").get();
  } catch {
    sqlite.prepare("ALTER TABLE tickets ADD COLUMN resolution_commits_json TEXT").run();
  }

  // Migration 15: Add worktree columns to sessions for dev loop isolation
  try {
    sqlite.prepare("SELECT worktree_path FROM sessions LIMIT 0").get();
  } catch {
    sqlite.prepare("ALTER TABLE sessions ADD COLUMN worktree_path TEXT").run();
  }
  try {
    sqlite.prepare("SELECT worktree_branch FROM sessions LIMIT 0").get();
  } catch {
    sqlite.prepare("ALTER TABLE sessions ADD COLUMN worktree_branch TEXT").run();
  }

  // Migration 16: Add required_roles_json column to tickets for dispatch-derived role enforcement
  try {
    sqlite.prepare("SELECT required_roles_json FROM tickets LIMIT 0").get();
  } catch {
    sqlite.prepare("ALTER TABLE tickets ADD COLUMN required_roles_json TEXT").run();
  }

  // Migration 17: Create commit_locks table for merge serialization
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS commit_locks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    ticket_id TEXT,
    acquired_at TEXT NOT NULL,
    released_at TEXT
  )`).run();

  // Migration 18: Create job_slots table for loop workforce management
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS job_slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    slot_id TEXT NOT NULL UNIQUE,
    loop_id TEXT NOT NULL,
    role TEXT NOT NULL,
    specialization TEXT,
    label TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT,
    context_json TEXT,
    ticket_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    agent_id TEXT,
    session_id TEXT,
    claimed_at TEXT,
    active_since TEXT,
    completed_at TEXT,
    last_heartbeat TEXT,
    progress_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_job_slots_loop_status ON job_slots(repo_id, loop_id, status)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_job_slots_agent ON job_slots(agent_id)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_job_slots_ticket ON job_slots(repo_id, ticket_id)`).run();

  // Migration 19: Create symbol_references table for symbol-level reference tracking
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS symbol_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_file_id INTEGER NOT NULL REFERENCES files(id),
    source_symbol_name TEXT,
    target_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    line INTEGER NOT NULL
  )`).run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_symbol_references_source_file ON symbol_references(source_file_id)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_symbol_references_target_name ON symbol_references(target_name)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_symbol_references_source_symbol ON symbol_references(source_symbol_name)").run();

  // Migration 20: Create work_groups and work_group_tickets tables
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS work_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    group_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_by TEXT NOT NULL,
    tags_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS work_group_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_group_id INTEGER NOT NULL REFERENCES work_groups(id),
    ticket_id INTEGER NOT NULL REFERENCES tickets(id),
    added_at TEXT NOT NULL,
    UNIQUE(work_group_id, ticket_id)
  )`).run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_work_groups_repo_status ON work_groups(repo_id, status)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_work_group_tickets_group ON work_group_tickets(work_group_id)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_work_group_tickets_ticket ON work_group_tickets(ticket_id)").run();

  // Migration 21: Wave scheduling columns for work groups
  try {
    sqlite.prepare("SELECT current_wave FROM work_groups LIMIT 0").get();
  } catch {
    sqlite.prepare("ALTER TABLE work_groups ADD COLUMN current_wave INTEGER").run();
  }
  try {
    sqlite.prepare("SELECT integration_branch FROM work_groups LIMIT 0").get();
  } catch {
    sqlite.prepare("ALTER TABLE work_groups ADD COLUMN integration_branch TEXT").run();
  }
  try {
    sqlite.prepare("SELECT wave_plan_json FROM work_groups LIMIT 0").get();
  } catch {
    sqlite.prepare("ALTER TABLE work_groups ADD COLUMN wave_plan_json TEXT").run();
  }
  try {
    sqlite.prepare("SELECT launched_at FROM work_groups LIMIT 0").get();
  } catch {
    sqlite.prepare("ALTER TABLE work_groups ADD COLUMN launched_at TEXT").run();
  }
  try {
    sqlite.prepare("SELECT wave_number FROM work_group_tickets LIMIT 0").get();
  } catch {
    sqlite.prepare("ALTER TABLE work_group_tickets ADD COLUMN wave_number INTEGER").run();
  }
  try {
    sqlite.prepare("SELECT wave_status FROM work_group_tickets LIMIT 0").get();
  } catch {
    sqlite.prepare("ALTER TABLE work_group_tickets ADD COLUMN wave_status TEXT DEFAULT 'pending'").run();
  }
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_wgt_wave ON work_group_tickets(work_group_id, wave_number)").run();

  // --- Additional indexes for high-traffic query patterns ---
  // Deduplicate files before adding unique index (existing DBs may have dupes from re-indexing)
  sqlite.prepare(`
    DELETE FROM files WHERE id NOT IN (
      SELECT MAX(id) FROM files GROUP BY repo_id, path
    )
  `).run();
  sqlite.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_files_repo_path ON files(repo_id, path)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_files_repo_language ON files(repo_id, language)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_tickets_repo_status ON tickets(repo_id, status)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_event_logs_timestamp ON event_logs(timestamp)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_event_logs_agent ON event_logs(agent_id)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_event_logs_session ON event_logs(session_id)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_coordination_messages_repo_ts ON coordination_messages(repo_id, timestamp)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_dashboard_events_repo_id ON dashboard_events(repo_id, id)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_notes_repo_type ON notes(repo_id, type)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_patches_repo_state ON patches(repo_id, state)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_imports_source_file ON imports(source_file_id)").run();
  // Deduplicate index_state before adding unique index
  sqlite.prepare(`
    DELETE FROM index_state WHERE id NOT IN (
      SELECT MAX(id) FROM index_state GROUP BY repo_id
    )
  `).run();
  sqlite.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_index_state_repo ON index_state(repo_id)").run();
  // Deduplicate ticket_dependencies before adding unique index (existing DBs may have dupes)
  sqlite.prepare(`
    DELETE FROM ticket_dependencies WHERE id NOT IN (
      SELECT MIN(id) FROM ticket_dependencies
      GROUP BY from_ticket_id, to_ticket_id, relation_type
    )
  `).run();
  sqlite.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_deps_unique ON ticket_dependencies(from_ticket_id, to_ticket_id, relation_type)").run();
}
