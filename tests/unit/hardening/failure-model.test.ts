import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { registerAgent, disconnectSession } from "../../../src/agents/registry.js";
import { CoordinationBus } from "../../../src/coordination/bus.js";
import { buildEvidenceBundle } from "../../../src/retrieval/evidence-bundle.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  for (const stmt of [
    `CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, path TEXT NOT NULL, language TEXT, content_hash TEXT, summary TEXT, symbols_json TEXT, has_secrets INTEGER DEFAULT 0, secret_line_ranges TEXT, indexed_at TEXT, commit_sha TEXT, embedding BLOB)`,
    `CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', provider TEXT, model TEXT, model_family TEXT, model_version TEXT, identity_source TEXT, role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL)`,
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT, worktree_path TEXT, worktree_branch TEXT)`,
  ]) {
    sqlite.prepare(stmt).run();
  }
  sqlite.prepare(`INSERT INTO repos (path, name, created_at) VALUES (?, ?, ?)`).run("/test", "test", new Date().toISOString());
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("Failure Model Tests", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    sqlite = result.sqlite;
  });
  afterEach(() => sqlite.close());

  // Agent disconnect mid-session
  it("disconnected session releases claims and marks inactive", () => {
    const reg = registerAgent(db, { name: "Dev", type: "test", desiredRole: "developer" });

    // Set claims
    sqlite.prepare(`UPDATE sessions SET claimed_files_json = ? WHERE id = ?`)
      .run(JSON.stringify(["src/a.ts", "src/b.ts"]), reg.sessionId);

    disconnectSession(db, reg.sessionId);

    const session = sqlite.prepare(`SELECT * FROM sessions WHERE id = ?`).get(reg.sessionId) as {
      state: string;
      claimed_files_json: string | null;
    };
    expect(session.state).toBe("disconnected");
    expect(JSON.parse(session.claimed_files_json!)).toEqual([]);
  });

  // Tree-sitter parser failure
  it("handles missing file records gracefully in evidence bundles", async () => {
    // No file record exists for the search result path
    const bundle = await buildEvidenceBundle({
      query: "nonexistent",
      repoId: 1,
      repoPath: "/test",
      commit: "abc123",
      trustTier: "A",
      searchBackend: "fts5",
      searchResults: [{ path: "missing.ts", score: 1.0 }],
      db,
      expand: true,
    });

    // Should return empty candidates (file not in index)
    expect(bundle.candidates).toHaveLength(0);
    expect(bundle.expanded).toHaveLength(0);
  });

  // Coordination bus isolation
  it("hub-spoke topology isolates direct messages", () => {
    const bus = new CoordinationBus("hub-spoke");

    bus.send({ from: "agent-1", to: "agent-2", type: "task_claim", payload: { file: "a.ts" } });

    // Agent 3 should not see the direct message
    expect(bus.getMessages("agent-3")).toHaveLength(0);
    // Agent 2 (target) sees it
    expect(bus.getMessages("agent-2")).toHaveLength(1);
    // Agent 1 (sender) does NOT see own direct messages
    expect(bus.getMessages("agent-1")).toHaveLength(0);
  });

  // Bundle reproducibility (Class 5)
  it("same query, same commit produces same bundleId", async () => {
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, summary, symbols_json) VALUES (?, ?, ?, ?, ?)`)
      .run(1, "src/app.ts", "typescript", "App module", "[]");

    const opts = {
      query: "app",
      repoId: 1,
      repoPath: "/test",
      commit: "abc123",
      trustTier: "A" as const,
      searchBackend: "fts5" as const,
      searchResults: [{ path: "src/app.ts", score: 1.0 }],
      db,
      expand: false,
    };

    const b1 = await buildEvidenceBundle(opts);
    const b2 = await buildEvidenceBundle(opts);
    const b3 = await buildEvidenceBundle(opts);

    expect(b1.bundleId).toBe(b2.bundleId);
    expect(b2.bundleId).toBe(b3.bundleId);
  });

  // Agent re-registration
  it("agent can re-register after disconnect", () => {
    const first = registerAgent(db, { name: "Dev", type: "test", desiredRole: "developer" });
    disconnectSession(db, first.sessionId);

    // Re-register creates new session
    const second = registerAgent(db, { name: "Dev2", type: "test", desiredRole: "developer" });
    expect(second.agentId).not.toBe(first.agentId);
    expect(second.sessionId).not.toBe(first.sessionId);
  });
});
