import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), path TEXT NOT NULL, language TEXT, content_hash TEXT, summary TEXT, symbols_json TEXT, has_secrets INTEGER DEFAULT 0, secret_line_ranges TEXT, indexed_at TEXT, commit_sha TEXT, embedding BLOB);
    CREATE TABLE imports (id INTEGER PRIMARY KEY AUTOINCREMENT, source_file_id INTEGER NOT NULL REFERENCES files(id), target_path TEXT NOT NULL, kind TEXT NOT NULL);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', provider TEXT, model TEXT, model_family TEXT, model_version TEXT, identity_source TEXT, role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT, worktree_path TEXT, worktree_branch TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), type TEXT NOT NULL, key TEXT NOT NULL UNIQUE, content TEXT NOT NULL, metadata_json TEXT, linked_paths_json TEXT, agent_id TEXT, session_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, required_roles_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), from_status TEXT, to_status TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, comment TEXT, timestamp TEXT NOT NULL);
    CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE event_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, tool TEXT NOT NULL, timestamp TEXT NOT NULL, duration_ms REAL NOT NULL, status TEXT NOT NULL, repo_id TEXT NOT NULL, commit_scope TEXT NOT NULL, payload_size_in INTEGER NOT NULL, payload_size_out INTEGER NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT NOT NULL, redacted_summary TEXT NOT NULL, error_code TEXT, error_detail TEXT, denial_reason TEXT);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("queries", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    sqlite = result.sqlite;
  });
  afterEach(() => sqlite.close());

  it("upserts and retrieves repos", () => {
    const { id } = queries.upsertRepo(db, "/repo", "repo");
    expect(id).toBeGreaterThan(0);
    expect(queries.upsertRepo(db, "/repo", "repo").id).toBe(id);
    expect(queries.getRepo(db, "/repo")?.name).toBe("repo");
  });

  it("upserts agents and lists all", () => {
    const now = new Date().toISOString();
    queries.upsertAgent(db, { id: "a1", name: "Agent", type: "t", roleId: "developer", trustTier: "A", registeredAt: now });
    queries.upsertAgent(db, { id: "a2", name: "Agent2", type: "t", roleId: "observer", trustTier: "B", registeredAt: now });
    expect(queries.getAllAgents(db).length).toBe(2);
    expect(queries.getAgent(db, "a1")?.name).toBe("Agent");
  });

  it("manages session lifecycle", () => {
    const now = new Date().toISOString();
    queries.upsertAgent(db, { id: "a1", name: "A", type: "t", roleId: "developer", trustTier: "A", registeredAt: now });
    queries.insertSession(db, { id: "s1", agentId: "a1", state: "active", connectedAt: now, lastActivity: now });

    queries.updateSessionClaims(db, "s1", ["src/index.ts"]);
    expect(JSON.parse(queries.getSession(db, "s1")!.claimedFilesJson!)).toEqual(["src/index.ts"]);
    expect(queries.getActiveSessions(db).length).toBe(1);

    queries.updateSessionState(db, "s1", "disconnected");
    expect(queries.getActiveSessions(db).length).toBe(0);
  });

  it("inserts and retrieves notes", () => {
    const { id: repoId } = queries.upsertRepo(db, "/r", "r");
    const now = new Date().toISOString();
    queries.insertNote(db, { repoId, type: "issue", key: "i-1", content: "Bug", commitSha: "abc", createdAt: now, updatedAt: now });
    expect(queries.getNoteByKey(db, "i-1")?.content).toBe("Bug");
    expect(queries.getNotesByRepo(db, repoId, "issue").length).toBe(1);
  });

  it("manages patch state", () => {
    const { id: repoId } = queries.upsertRepo(db, "/r", "r");
    const now = new Date().toISOString();
    queries.insertPatch(db, { repoId, proposalId: "p-1", baseCommit: "abc", state: "proposed", diff: "d", message: "m", agentId: "a", sessionId: "s", createdAt: now, updatedAt: now });
    expect(queries.getPatchByProposalId(db, "p-1")?.state).toBe("proposed");
    queries.updatePatchState(db, "p-1", "applied");
    expect(queries.getPatchByProposalId(db, "p-1")?.state).toBe("applied");
  });

  it("inserts and queries event logs", () => {
    const older = "2026-03-10T00:00:00.000Z";
    const now = "2026-03-12T00:00:00.000Z";
    queries.insertEventLog(db, { eventId: "e1", agentId: "a1", sessionId: "s1", tool: "get_code_pack", timestamp: older, durationMs: 150, status: "success", repoId: "r1", commitScope: "abc", payloadSizeIn: 100, payloadSizeOut: 2000, inputHash: "hi", outputHash: "ho", redactedSummary: "old", errorCode: null, errorDetail: null });
    queries.insertEventLog(db, { eventId: "e2", agentId: "a1", sessionId: "s1", tool: "get_issue_pack", timestamp: now, durationMs: 180, status: "success", repoId: "r1", commitScope: "abc", payloadSizeIn: 120, payloadSizeOut: 2100, inputHash: "hi2", outputHash: "ho2", redactedSummary: "new", errorCode: null, errorDetail: null });
    expect(queries.getEventLogs(db, 10).length).toBe(2);
    expect(queries.getEventLogsByAgent(db, "a1").length).toBe(2);
    expect(queries.getEventLogs(db, 10, "2026-03-11T00:00:00.000Z").map((event) => event.eventId)).toEqual(["e2"]);
  });

  it("builds import graphs with resolved internal edges and focused neighborhoods", () => {
    const { id: repoId } = queries.upsertRepo(db, "/r", "r");
    const now = new Date().toISOString();
    const insertFile = sqlite.prepare(`
      INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertFile.run(repoId, "src/a.ts", "typescript", "h1", "summary", "[]", now, "abc");
    insertFile.run(repoId, "src/b.ts", "typescript", "h2", "summary", "[]", now, "abc");
    insertFile.run(repoId, "src/c.ts", "typescript", "h3", "summary", "[]", now, "abc");

    const aId = queries.getFileByPath(db, repoId, "src/a.ts")!.id;
    const cId = queries.getFileByPath(db, repoId, "src/c.ts")!.id;
    sqlite.prepare(`INSERT INTO imports (source_file_id, target_path, kind) VALUES (?, ?, ?)`).run(aId, "./b.js", "import");
    sqlite.prepare(`INSERT INTO imports (source_file_id, target_path, kind) VALUES (?, ?, ?)`).run(cId, "./a.js", "import");

    const full = queries.getImportGraph(db, repoId, { scope: "src/" });
    expect(full.files).toHaveLength(3);
    expect(full.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: aId, target: queries.getFileByPath(db, repoId, "src/b.ts")!.id }),
      expect.objectContaining({ source: cId, target: aId }),
    ]));

    const focused = queries.getImportGraph(db, repoId, { focusFilePath: "src/a.ts" });
    expect(focused.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(focused.edges).toHaveLength(2);
  });

  it("rejects import candidates that still escape the repo after normalization", () => {
    const { id: repoId } = queries.upsertRepo(db, "/r", "r");
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(repoId, "src/a.ts", "typescript", "h1", "summary", "[]", now, "abc");

    const aId = queries.getFileByPath(db, repoId, "src/a.ts")!.id;
    sqlite.prepare(`INSERT INTO imports (source_file_id, target_path, kind) VALUES (?, ?, ?)`)
      .run(aId, "../../../outside.js", "import");

    const graph = queries.getImportGraph(db, repoId, { scope: "src/" });
    expect(graph.edges).toEqual([]);
  });
});
