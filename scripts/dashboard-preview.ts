/**
 * Standalone dashboard preview for verification.
 * Creates an in-memory DB, seeds test data, and starts the dashboard on :3141.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../src/db/schema.js";
import { CoordinationBus } from "../src/coordination/bus.js";
import { startDashboard } from "../src/dashboard/server.js";
import { InsightStream } from "../src/core/insight-stream.js";

const sqlite = new Database(":memory:");
sqlite.pragma("journal_mode = WAL");

for (const stmt of [
  `CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE index_state (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, db_indexed_commit TEXT, zoekt_indexed_commit TEXT, indexed_at TEXT, last_success TEXT, last_error TEXT)`,
  `CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, path TEXT NOT NULL, language TEXT, content_hash TEXT, summary TEXT, symbols_json TEXT, has_secrets INTEGER DEFAULT 0, secret_line_ranges TEXT, indexed_at TEXT, commit_sha TEXT)`,
  `CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL)`,
  `CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT)`,
  `CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL UNIQUE, content TEXT NOT NULL, metadata_json TEXT, linked_paths_json TEXT, agent_id TEXT, session_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE event_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, tool TEXT NOT NULL, timestamp TEXT NOT NULL, duration_ms REAL NOT NULL, status TEXT NOT NULL, repo_id TEXT NOT NULL, commit_scope TEXT NOT NULL, payload_size_in INTEGER NOT NULL, payload_size_out INTEGER NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT NOT NULL, redacted_summary TEXT NOT NULL, denial_reason TEXT)`,
]) {
  sqlite.prepare(stmt).run();
}

const db = drizzle(sqlite, { schema });
const now = new Date().toISOString();

// Seed test data
sqlite.prepare(`INSERT INTO repos (path, name, created_at) VALUES (?, ?, ?)`).run("/demo/project", "demo-project", now);
sqlite.prepare(`INSERT INTO files (repo_id, path, language, summary, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?)`).run(1, "src/index.ts", "typescript", "Main entry point", now, "abc1234");
sqlite.prepare(`INSERT INTO files (repo_id, path, language, summary, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?)`).run(1, "src/utils.ts", "typescript", "Utility functions", now, "abc1234");
sqlite.prepare(`INSERT INTO files (repo_id, path, language, summary, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?)`).run(1, "lib/helpers.py", "python", "Python helpers", now, "abc1234");

sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`).run("agent-dev01", "Claude-Dev", "claude-code", "developer", "A", now);
sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`).run("agent-rev01", "Codex-Review", "codex", "reviewer", "A", now);
sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`).run("agent-obs01", "Watcher", "opencode", "observer", "B", now);

sqlite.prepare(`INSERT INTO sessions (id, agent_id, state, connected_at, last_activity) VALUES (?, ?, ?, ?, ?)`).run("sess-001", "agent-dev01", "active", now, now);
sqlite.prepare(`INSERT INTO sessions (id, agent_id, state, connected_at, last_activity) VALUES (?, ?, ?, ?, ?)`).run("sess-002", "agent-rev01", "active", now, now);
sqlite.prepare(`INSERT INTO sessions (id, agent_id, state, connected_at, last_activity) VALUES (?, ?, ?, ?, ?)`).run("sess-003", "agent-obs01", "disconnected", now, now);

sqlite.prepare(`INSERT INTO patches (repo_id, proposal_id, base_commit, state, diff, message, agent_id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(1, "patch-abc12345", "abc1234", "validated", "--- a/x\n+++ b/x", "Fix auth bug", "agent-dev01", "sess-001", now, now);
sqlite.prepare(`INSERT INTO patches (repo_id, proposal_id, base_commit, state, diff, message, agent_id, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(1, "patch-def67890", "old1234", "stale", "--- a/y\n+++ b/y", "Refactor utils", "agent-dev01", "sess-001", now, now);

sqlite.prepare(`INSERT INTO notes (repo_id, type, key, content, agent_id, session_id, commit_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(1, "decision", "decision:abc123", "Use SQLite for persistence instead of JSON files", "agent-dev01", "sess-001", "abc1234", now, now);
sqlite.prepare(`INSERT INTO notes (repo_id, type, key, content, agent_id, session_id, commit_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(1, "gotcha", "gotcha:def456", "tree-sitter WASM files must match web-tree-sitter version exactly", "agent-rev01", "sess-002", "abc1234", now, now);

sqlite.prepare(`INSERT INTO event_logs (event_id, agent_id, session_id, tool, timestamp, duration_ms, status, repo_id, commit_scope, payload_size_in, payload_size_out, input_hash, output_hash, redacted_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("evt-001", "agent-dev01", "sess-001", "get_code_pack", now, 145.2, "success", "1", "abc1234", 128, 4096, "hash1", "hash2", "get_code_pack: success");
sqlite.prepare(`INSERT INTO event_logs (event_id, agent_id, session_id, tool, timestamp, duration_ms, status, repo_id, commit_scope, payload_size_in, payload_size_out, input_hash, output_hash, redacted_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run("evt-002", "agent-obs01", "sess-003", "propose_patch", now, 12.5, "denied", "1", "abc1234", 256, 64, "hash3", "hash4", "propose_patch: denied");

const bus = new CoordinationBus("hub-spoke");
const insight = new InsightStream("normal");

startDashboard({ db, repoId: 1, repoPath: "/demo/project", bus }, 3141, insight);
console.log("Dashboard preview running on http://localhost:3141");
