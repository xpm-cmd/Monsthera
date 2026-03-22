/**
 * Shared test database builders.
 * Replaces 40+ createTestDb copies across test files.
 *
 * Uses a single full-schema builder — SQLite in-memory DBs are cheap,
 * and having all tables avoids "no such table" errors when tests
 * indirectly touch adjacent domains.
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../../src/db/schema.js";
import * as queries from "../../src/db/queries.js";

const FULL_SCHEMA_SQL = `
  CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', provider TEXT, model TEXT, model_family TEXT, model_version TEXT, identity_source TEXT, role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT, worktree_path TEXT, worktree_branch TEXT);
  CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, required_roles_json TEXT, resolution_commits_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), from_status TEXT, to_status TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, comment TEXT, timestamp TEXT NOT NULL);
  CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE review_verdicts (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, specialization TEXT NOT NULL, verdict TEXT NOT NULL, reasoning TEXT, created_at TEXT NOT NULL, superseded_by INTEGER);
  CREATE TABLE council_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, specialization TEXT NOT NULL, assigned_by_agent_id TEXT NOT NULL, assigned_at TEXT NOT NULL, UNIQUE(ticket_id, specialization));
  CREATE TABLE ticket_dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, from_ticket_id INTEGER NOT NULL REFERENCES tickets(id), to_ticket_id INTEGER NOT NULL REFERENCES tickets(id), relation_type TEXT NOT NULL, created_by_agent_id TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), type TEXT NOT NULL, key TEXT NOT NULL UNIQUE, content TEXT NOT NULL, metadata_json TEXT, linked_paths_json TEXT, agent_id TEXT, session_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE coordination_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), message_id TEXT NOT NULL UNIQUE, from_agent_id TEXT NOT NULL, to_agent_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL, timestamp TEXT NOT NULL);
  CREATE TABLE dashboard_events (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), event_type TEXT NOT NULL, data_json TEXT NOT NULL, timestamp TEXT NOT NULL);
  CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT, status TEXT NOT NULL DEFAULT 'active', agent_id TEXT, session_id TEXT, embedding BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE VIRTUAL TABLE knowledge_fts USING fts5(knowledge_id UNINDEXED, title, content, type UNINDEXED, tags);
  CREATE TABLE work_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), group_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL, tags_json TEXT, current_wave INTEGER, integration_branch TEXT, wave_plan_json TEXT, launched_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE work_group_tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, work_group_id INTEGER NOT NULL REFERENCES work_groups(id), ticket_id INTEGER NOT NULL REFERENCES tickets(id), wave_number INTEGER, wave_status TEXT DEFAULT 'pending', added_at TEXT NOT NULL, UNIQUE(work_group_id, ticket_id));
  CREATE TABLE job_slots (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), slot_id TEXT NOT NULL UNIQUE, loop_id TEXT NOT NULL, role TEXT NOT NULL, specialization TEXT, label TEXT NOT NULL, description TEXT, system_prompt TEXT, context_json TEXT, ticket_id TEXT, status TEXT NOT NULL DEFAULT 'open', agent_id TEXT, session_id TEXT, claimed_at TEXT, active_since TEXT, completed_at TEXT, last_heartbeat TEXT, progress_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE commit_locks (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, ticket_id TEXT, acquired_at TEXT NOT NULL, released_at TEXT);
  CREATE TABLE event_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, tool TEXT NOT NULL, timestamp TEXT NOT NULL, duration_ms REAL NOT NULL, status TEXT NOT NULL, repo_id TEXT NOT NULL, commit_scope TEXT NOT NULL, payload_size_in INTEGER NOT NULL, payload_size_out INTEGER NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT NOT NULL, redacted_summary TEXT NOT NULL, error_code TEXT, error_detail TEXT, denial_reason TEXT);
  CREATE TABLE protected_artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), path_pattern TEXT NOT NULL, reason TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE debug_payloads (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES event_logs(event_id), raw_input TEXT, raw_output TEXT, expires_at TEXT NOT NULL);
`;

export function createTestDb(): { db: BetterSQLite3Database<typeof schema>; sqlite: InstanceType<typeof Database> } {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(FULL_SCHEMA_SQL);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

/** Seed a standard agent + session pair for testing. */
export function seedAgent(
  db: BetterSQLite3Database<typeof schema>,
  agentId: string,
  sessionId: string,
  opts?: { name?: string; role?: string; trustTier?: string },
) {
  const now = new Date().toISOString();
  queries.upsertAgent(db, {
    id: agentId,
    name: opts?.name ?? agentId,
    type: "test",
    roleId: opts?.role ?? "developer",
    trustTier: opts?.trustTier ?? "A",
    registeredAt: now,
  });
  queries.insertSession(db, {
    id: sessionId,
    agentId,
    state: "active",
    connectedAt: now,
    lastActivity: now,
  });
}
