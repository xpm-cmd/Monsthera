import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { registerIndexTools } from "../../../src/tools/index-tools.js";

vi.mock("../../../src/indexing/indexer.js", () => ({
  fullIndex: vi.fn(),
  incrementalIndex: vi.fn(),
  getIndexedCommit: vi.fn(() => null),
  buildIndexOptions: vi.fn((ctx: any) => ctx),
}));

import { fullIndex, incrementalIndex, getIndexedCommit } from "../../../src/indexing/indexer.js";

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<any>>();

  tool(name: string, _description: string, _schema: object, handler: (input: unknown) => Promise<any>) {
    this.handlers.set(name, handler);
  }
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE index_state (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, db_indexed_commit TEXT, zoekt_indexed_commit TEXT, indexed_at TEXT, last_success TEXT, last_error TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', provider TEXT, model TEXT, model_family TEXT, model_version TEXT, identity_source TEXT, role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT, worktree_path TEXT, worktree_branch TEXT);
    CREATE TABLE dashboard_events (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, event_type TEXT NOT NULL, data_json TEXT NOT NULL, timestamp TEXT NOT NULL);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("index tools", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let repoId: number;
  const now = new Date().toISOString();

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;

    for (const agent of [
      { id: "agent-dev", roleId: "developer", trustTier: "A" },
      { id: "agent-obs", roleId: "observer", trustTier: "B" },
    ]) {
      queries.upsertAgent(db, {
        id: agent.id,
        name: agent.id,
        type: "test",
        roleId: agent.roleId as "developer" | "observer",
        trustTier: agent.trustTier as "A" | "B",
        registeredAt: now,
      });
      queries.insertSession(db, {
        id: `session-${agent.id}`,
        agentId: agent.id,
        state: "active",
        connectedAt: now,
        lastActivity: now,
      });
    }

    vi.mocked(fullIndex).mockResolvedValue({
      commit: "abc1234",
      filesIndexed: 3,
      filesSkipped: 0,
      errors: [],
      durationMs: 42,
    });

    server = new FakeServer();
    registerIndexTools(server as unknown as McpServer, async () => ({
      db,
      repoId,
      repoPath: "/test",
      config: {
        sensitiveFilePatterns: [],
        excludePatterns: [],
      },
      searchRouter: {
        getSemanticReranker: () => null,
        rebuildIndex: vi.fn(),
      },
      insight: {
        info: vi.fn(),
        detail: vi.fn(),
        warn: vi.fn(),
      },
    } as any));
  });

  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
  });

  function handler(name: string) {
    const found = server.handlers.get(name);
    expect(found).toBeTypeOf("function");
    return found!;
  }

  it("allows a developer to request reindexing", async () => {
    const result = await handler("request_reindex")({
      full: true,
      agentId: "agent-dev",
      sessionId: "session-agent-dev",
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      commit: "abc1234",
      filesIndexed: 3,
      durationMs: 42,
    });
    expect(fullIndex).toHaveBeenCalledOnce();
  });

  it("denies observer reindex requests", async () => {
    const result = await handler("request_reindex")({
      full: true,
      agentId: "agent-obs",
      sessionId: "session-agent-obs",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not have access to request_reindex");
  });

  it("dispatches incremental index when getIndexedCommit returns a commit SHA", async () => {
    const fakeSha = "a".repeat(40);
    vi.mocked(getIndexedCommit).mockReturnValue(fakeSha);
    vi.mocked(incrementalIndex).mockResolvedValue({
      commit: "b".repeat(40),
      filesIndexed: 2,
      filesSkipped: 1,
      errors: [],
      durationMs: 10,
    });

    const result = await handler("request_reindex")({
      full: false,
      agentId: "agent-dev",
      sessionId: "session-agent-dev",
    });

    expect(result.isError).toBeUndefined();
    expect(incrementalIndex).toHaveBeenCalledOnce();
    expect(incrementalIndex).toHaveBeenCalledWith(fakeSha, expect.anything());
    expect(fullIndex).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      filesIndexed: 2,
      durationMs: 10,
    });
  });
});
