/**
 * Sandbox harness for simulation Phase B.
 *
 * Creates an in-memory SQLite database with the full Agora schema,
 * wires up FTS5, CoordinationBus, and SearchRouter so that ticket
 * tools and workflows run against an isolated sandbox.
 *
 * The sandbox is auto-destroyed when dispose() is called.
 */

import Database, { type Database as DatabaseType } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";
import { FTS5Backend } from "../search/fts5.js";
import { SearchRouter } from "../search/router.js";
import { CoordinationBus } from "../coordination/bus.js";
import type { InsightStream } from "../core/insight-stream.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxContext {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: DatabaseType;
  repoId: number;
  repoPath: string;
  searchRouter: SearchRouter;
  fts5: FTS5Backend;
  bus: CoordinationBus;
  insight: InsightStream;
  dispose: () => void;
}

export interface SandboxOptions {
  repoPath: string;
  repoName?: string;
}

// ---------------------------------------------------------------------------
// Schema SQL — mirrors production schema from src/db/schema.ts
// ---------------------------------------------------------------------------

function buildSchemaSQL(): string {
  const statements = [
    [
      "CREATE TABLE repos (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  path TEXT NOT NULL UNIQUE,",
      "  name TEXT NOT NULL,",
      "  created_at TEXT NOT NULL",
      ")",
    ],
    [
      "CREATE TABLE index_state (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  repo_id INTEGER NOT NULL REFERENCES repos(id),",
      "  db_indexed_commit TEXT,",
      "  zoekt_indexed_commit TEXT,",
      "  indexed_at TEXT,",
      "  last_success TEXT,",
      "  last_error TEXT",
      ")",
    ],
    [
      "CREATE TABLE files (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  repo_id INTEGER NOT NULL REFERENCES repos(id),",
      "  path TEXT NOT NULL,",
      "  language TEXT,",
      "  content_hash TEXT,",
      "  summary TEXT,",
      "  symbols_json TEXT,",
      "  has_secrets INTEGER DEFAULT 0",
      ")",
    ],
    [
      "CREATE TABLE imports (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  source_file_id INTEGER NOT NULL REFERENCES files(id),",
      "  target_path TEXT NOT NULL,",
      "  kind TEXT NOT NULL",
      ")",
    ],
    [
      "CREATE TABLE agents (",
      "  id TEXT PRIMARY KEY,",
      "  name TEXT NOT NULL,",
      "  type TEXT NOT NULL DEFAULT 'unknown',",
      "  provider TEXT,",
      "  model TEXT,",
      "  model_family TEXT,",
      "  model_version TEXT,",
      "  identity_source TEXT,",
      "  role_id TEXT NOT NULL DEFAULT 'observer',",
      "  trust_tier TEXT NOT NULL DEFAULT 'B',",
      "  registered_at TEXT NOT NULL",
      ")",
    ],
    [
      "CREATE TABLE sessions (",
      "  id TEXT PRIMARY KEY,",
      "  agent_id TEXT NOT NULL REFERENCES agents(id),",
      "  state TEXT NOT NULL DEFAULT 'active',",
      "  connected_at TEXT NOT NULL,",
      "  last_activity TEXT NOT NULL,",
      "  claimed_files_json TEXT,",
      "  worktree_path TEXT,",
      "  worktree_branch TEXT",
      ")",
    ],
    [
      "CREATE TABLE tickets (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  repo_id INTEGER NOT NULL REFERENCES repos(id),",
      "  ticket_id TEXT NOT NULL UNIQUE,",
      "  title TEXT NOT NULL,",
      "  description TEXT NOT NULL,",
      "  status TEXT NOT NULL DEFAULT 'backlog',",
      "  severity TEXT NOT NULL DEFAULT 'medium',",
      "  priority INTEGER NOT NULL DEFAULT 5,",
      "  tags_json TEXT,",
      "  affected_paths_json TEXT,",
      "  acceptance_criteria TEXT,",
      "  creator_agent_id TEXT NOT NULL,",
      "  creator_session_id TEXT NOT NULL,",
      "  assignee_agent_id TEXT,",
      "  resolved_by_agent_id TEXT,",
      "  commit_sha TEXT NOT NULL,",
      "  required_roles_json TEXT,",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL",
      ")",
    ],
    [
      "CREATE TABLE ticket_history (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  ticket_id INTEGER NOT NULL REFERENCES tickets(id),",
      "  from_status TEXT,",
      "  to_status TEXT NOT NULL,",
      "  agent_id TEXT NOT NULL,",
      "  session_id TEXT NOT NULL,",
      "  comment TEXT,",
      "  timestamp TEXT NOT NULL",
      ")",
    ],
    [
      "CREATE TABLE ticket_comments (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  ticket_id INTEGER NOT NULL REFERENCES tickets(id),",
      "  agent_id TEXT NOT NULL,",
      "  session_id TEXT NOT NULL,",
      "  content TEXT NOT NULL,",
      "  created_at TEXT NOT NULL",
      ")",
    ],
    [
      "CREATE TABLE review_verdicts (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  ticket_id INTEGER NOT NULL REFERENCES tickets(id),",
      "  agent_id TEXT NOT NULL,",
      "  session_id TEXT NOT NULL,",
      "  specialization TEXT NOT NULL,",
      "  verdict TEXT NOT NULL,",
      "  reasoning TEXT,",
      "  created_at TEXT NOT NULL,",
      "  superseded_by INTEGER",
      ")",
    ],
    [
      "CREATE TABLE council_assignments (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  ticket_id INTEGER NOT NULL REFERENCES tickets(id),",
      "  agent_id TEXT NOT NULL,",
      "  specialization TEXT NOT NULL,",
      "  assigned_by_agent_id TEXT NOT NULL,",
      "  assigned_at TEXT NOT NULL",
      ")",
    ],
    "CREATE UNIQUE INDEX idx_council_assignments_ticket_specialization ON council_assignments(ticket_id, specialization)",
    "CREATE INDEX idx_council_assignments_ticket_agent ON council_assignments(ticket_id, agent_id)",
    [
      "CREATE TABLE coordination_messages (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  repo_id INTEGER NOT NULL REFERENCES repos(id),",
      "  message_id TEXT NOT NULL UNIQUE,",
      "  from_agent_id TEXT NOT NULL,",
      "  to_agent_id TEXT,",
      "  type TEXT NOT NULL,",
      "  payload_json TEXT NOT NULL,",
      "  timestamp TEXT NOT NULL",
      ")",
    ],
    [
      "CREATE TABLE dashboard_events (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  repo_id INTEGER NOT NULL REFERENCES repos(id),",
      "  event_type TEXT NOT NULL,",
      "  data_json TEXT NOT NULL,",
      "  timestamp TEXT NOT NULL",
      ")",
    ],
    [
      "CREATE TABLE ticket_dependencies (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  from_ticket_id INTEGER NOT NULL REFERENCES tickets(id),",
      "  to_ticket_id INTEGER NOT NULL REFERENCES tickets(id),",
      "  relation_type TEXT NOT NULL,",
      "  created_by_agent_id TEXT NOT NULL,",
      "  created_at TEXT NOT NULL",
      ")",
    ],
    [
      "CREATE TABLE patches (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  repo_id INTEGER NOT NULL REFERENCES repos(id),",
      "  proposal_id TEXT NOT NULL UNIQUE,",
      "  base_commit TEXT NOT NULL,",
      "  bundle_id TEXT,",
      "  state TEXT NOT NULL,",
      "  diff TEXT NOT NULL,",
      "  message TEXT NOT NULL,",
      "  touched_paths_json TEXT,",
      "  dry_run_result_json TEXT,",
      "  agent_id TEXT NOT NULL,",
      "  session_id TEXT NOT NULL,",
      "  committed_sha TEXT,",
      "  ticket_id INTEGER REFERENCES tickets(id),",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL",
      ")",
    ],
    [
      "CREATE TABLE knowledge (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  key TEXT NOT NULL UNIQUE,",
      "  type TEXT NOT NULL,",
      "  scope TEXT NOT NULL,",
      "  title TEXT NOT NULL,",
      "  content TEXT NOT NULL,",
      "  tags_json TEXT,",
      "  status TEXT NOT NULL DEFAULT 'active',",
      "  agent_id TEXT,",
      "  session_id TEXT,",
      "  embedding BLOB,",
      "  created_at TEXT NOT NULL,",
      "  updated_at TEXT NOT NULL",
      ")",
    ],
    "CREATE VIRTUAL TABLE knowledge_fts USING fts5(knowledge_id UNINDEXED, title, content, type UNINDEXED, tags)",
    [
      "CREATE TABLE protected_artifacts (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  repo_id INTEGER NOT NULL REFERENCES repos(id),",
      "  path_pattern TEXT NOT NULL,",
      "  reason TEXT NOT NULL,",
      "  created_by TEXT NOT NULL,",
      "  created_at TEXT NOT NULL",
      ")",
    ],
    [
      "CREATE TABLE commit_locks (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  session_id TEXT NOT NULL,",
      "  agent_id TEXT NOT NULL,",
      "  ticket_id TEXT,",
      "  acquired_at TEXT NOT NULL,",
      "  released_at TEXT",
      ")",
    ],
    [
      "CREATE TABLE event_logs (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  event_id TEXT NOT NULL UNIQUE,",
      "  agent_id TEXT NOT NULL,",
      "  session_id TEXT NOT NULL,",
      "  tool TEXT NOT NULL,",
      "  timestamp TEXT NOT NULL,",
      "  duration_ms REAL NOT NULL,",
      "  status TEXT NOT NULL,",
      "  repo_id TEXT NOT NULL,",
      "  commit_scope TEXT NOT NULL,",
      "  payload_size_in INTEGER NOT NULL,",
      "  payload_size_out INTEGER NOT NULL,",
      "  input_hash TEXT NOT NULL,",
      "  output_hash TEXT NOT NULL,",
      "  redacted_summary TEXT NOT NULL,",
      "  error_code TEXT,",
      "  error_detail TEXT,",
      "  denial_reason TEXT",
      ")",
    ],
    [
      "CREATE TABLE debug_payloads (",
      "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
      "  event_id TEXT NOT NULL REFERENCES event_logs(event_id),",
      "  raw_input TEXT,",
      "  raw_output TEXT,",
      "  expires_at TEXT NOT NULL",
      ")",
    ],
  ];

  return statements
    .map((s) => (Array.isArray(s) ? s.join("\n") : s))
    .join(";\n") + ";";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a fully wired sandbox with in-memory DB, FTS5, bus, and search router.
 * Call dispose() when done to close the DB connection.
 */
export function createSandbox(options: SandboxOptions): SandboxContext {
  const { repoPath, repoName = "sandbox-repo" } = options;

  // 1. In-memory DB with full schema
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(buildSchemaSQL());

  const db = drizzle(sqlite, { schema });

  // 2. Repo registration
  const { id: repoId } = queries.upsertRepo(db, repoPath, repoName);

  // 3. FTS5 backend
  const fts5 = new FTS5Backend(sqlite, db);
  fts5.initTicketFts();

  // 4. Coordination bus
  const bus = new CoordinationBus("hub-spoke", 200, db, repoId);

  // 5. Search router (FTS5-only, no zoekt/semantic in sandbox)
  const searchRouter = new SearchRouter({
    repoId,
    sqlite,
    db,
    repoPath,
    zoektEnabled: false,
    semanticEnabled: false,
    indexDir: "",
  });

  // 6. Silent insight stream
  const insight: InsightStream = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
    tool: () => undefined,
  } as unknown as InsightStream;

  const dispose = () => {
    sqlite.close();
  };

  return { db, sqlite, repoId, repoPath, searchRouter, fts5, bus, insight, dispose };
}

/**
 * Registers a simulation agent and session in the sandbox.
 */
export function registerSandboxAgent(
  ctx: SandboxContext,
  agentId: string,
  opts?: {
    name?: string;
    model?: string;
    modelFamily?: string;
    trustTier?: string;
    roleId?: string;
  },
): { agentId: string; sessionId: string } {
  const now = new Date().toISOString();
  const sessionId = `sim-session-${agentId}-${Date.now()}`;

  queries.upsertAgent(ctx.db, {
    id: agentId,
    name: opts?.name ?? agentId,
    type: "simulation",
    provider: "simulation",
    model: opts?.model ?? "sonnet",
    modelFamily: opts?.modelFamily ?? "claude",
    modelVersion: null,
    identitySource: "simulation",
    roleId: opts?.roleId ?? "developer",
    trustTier: opts?.trustTier ?? "A",
    registeredAt: now,
  });

  queries.insertSession(ctx.db, {
    id: sessionId,
    agentId,
    state: "active",
    connectedAt: now,
    lastActivity: now,
    claimedFilesJson: null,
    worktreePath: null,
    worktreeBranch: null,
  });

  return { agentId, sessionId };
}
