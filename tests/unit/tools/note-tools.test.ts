import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { registerNoteTools } from "../../../src/tools/note-tools.js";

vi.mock("../../../src/git/operations.js", () => ({
  getHead: vi.fn().mockResolvedValue("abc1234"),
}));

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
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', provider TEXT, model TEXT, model_family TEXT, model_version TEXT, identity_source TEXT, role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT, worktree_path TEXT, worktree_branch TEXT);
    CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL UNIQUE, content TEXT NOT NULL, metadata_json TEXT, linked_paths_json TEXT, agent_id TEXT, session_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("note tools", () => {
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
      { id: "agent-review", roleId: "reviewer", trustTier: "A" },
      { id: "agent-obs", roleId: "observer", trustTier: "B" },
    ]) {
      queries.upsertAgent(db, {
        id: agent.id,
        name: agent.id,
        type: "test",
        roleId: agent.roleId as "developer" | "reviewer" | "observer",
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

    queries.insertNote(db, {
      repoId,
      type: "issue",
      key: "issue:1",
      content: "Open issue",
      metadataJson: "{}",
      linkedPathsJson: "[]",
      agentId: "agent-dev",
      sessionId: "session-agent-dev",
      commitSha: "abc1234",
      createdAt: now,
      updatedAt: now,
    });

    server = new FakeServer();
    registerNoteTools(server as unknown as McpServer, async () => ({
      db,
      repoId,
      repoPath: "/test",
      insight: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as any));
  });

  afterEach(() => sqlite.close());

  function handler(name: string) {
    const found = server.handlers.get(name);
    expect(found).toBeTypeOf("function");
    return found!;
  }

  it("lists notes for a reviewer with a validated session", async () => {
    const result = await handler("list_notes")({
      agentId: "agent-review",
      sessionId: "session-agent-review",
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.notes[0]).toMatchObject({
      key: "issue:1",
      type: "issue",
    });
  });

  it("denies observer note listing", async () => {
    const result = await handler("list_notes")({
      agentId: "agent-obs",
      sessionId: "session-agent-obs",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not have access to list_notes");
  });
});
