import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { registerPatchTools } from "../../../src/tools/patch-tools.js";
import { validatePatch } from "../../../src/patches/validator.js";

vi.mock("../../../src/patches/validator.js", () => ({
  validatePatch: vi.fn(),
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
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, required_roles_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE dashboard_events (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, event_type TEXT NOT NULL, data_json TEXT NOT NULL, timestamp TEXT NOT NULL);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("patch tools", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let repoId: number;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    queries.upsertAgent(db, {
      id: "agent-1",
      name: "Dev",
      type: "claude-code",
      roleId: "developer",
      trustTier: "A",
      registeredAt: new Date().toISOString(),
    });
    queries.insertSession(db, {
      id: "session-1",
      agentId: "agent-1",
      state: "active",
      connectedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    });

    server = new FakeServer();
    registerPatchTools(server as unknown as McpServer, async () => ({
      db,
      repoId,
      repoPath: "/test",
      insight: { info: vi.fn(), warn: vi.fn() },
    } as any));

    vi.mocked(validatePatch).mockResolvedValue({
      proposalId: "patch-123",
      valid: true,
      stale: false,
      currentHead: "abc1234",
      dryRunResult: {
        feasible: true,
        touchedPaths: ["src/file.ts"],
        policyViolations: [],
        secretWarnings: [],
        reindexScope: 1,
      },
    });
  });

  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
  });

  it("rejects an invalid ticketId without persisting a patch", async () => {
    const proposePatch = server.handlers.get("propose_patch");
    expect(proposePatch).toBeTypeOf("function");

    const result = await proposePatch!({
      diff: "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old\n+new",
      message: "Fix bug",
      baseCommit: "abc1234",
      agentId: "agent-1",
      sessionId: "session-1",
      ticketId: "TKT-missing",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Ticket not found");
    expect(queries.getPatchesByRepo(db, repoId)).toHaveLength(0);
  });

  it("rejects linking a patch to a ticket from another repo", async () => {
    const otherRepoId = queries.upsertRepo(db, "/other", "other").id;
    queries.insertTicket(db, {
      repoId: otherRepoId,
      ticketId: "TKT-foreign01",
      title: "Foreign ticket",
      description: "Hidden from this repo",
      status: "backlog",
      severity: "medium",
      priority: 5,
      creatorAgentId: "agent-1",
      creatorSessionId: "session-1",
      commitSha: "abc1234",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const proposePatch = server.handlers.get("propose_patch");
    expect(proposePatch).toBeTypeOf("function");

    const result = await proposePatch!({
      diff: "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old\n+new",
      message: "Fix bug",
      baseCommit: "abc1234",
      agentId: "agent-1",
      sessionId: "session-1",
      ticketId: "TKT-foreign01",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Ticket not found");
    expect(queries.getPatchesByRepo(db, repoId)).toHaveLength(0);
  });

  it("records patch_proposed dashboard event on successful submission", async () => {
    const proposePatch = server.handlers.get("propose_patch")!;
    await proposePatch({
      diff: "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old\n+new",
      message: "Fix bug",
      baseCommit: "abc1234",
      agentId: "agent-1",
      sessionId: "session-1",
    });

    const events = sqlite.prepare(
      "SELECT event_type, data_json FROM dashboard_events WHERE repo_id = ?",
    ).all(repoId) as Array<{ event_type: string; data_json: string }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("patch_proposed");
    const data = JSON.parse(events[0]!.data_json);
    expect(data).toMatchObject({
      proposalId: "patch-123",
      state: "validated",
      agentId: "agent-1",
      message: "Fix bug",
      ticketId: null,
    });
  });

  it("does not record patch_proposed event on dry run", async () => {
    const proposePatch = server.handlers.get("propose_patch")!;
    await proposePatch({
      diff: "--- a/src/file.ts\n+++ b/src/file.ts\n@@ -1 +1 @@\n-old\n+new",
      message: "Test",
      baseCommit: "abc1234",
      agentId: "agent-1",
      sessionId: "session-1",
      dryRun: true,
    });

    const events = sqlite.prepare("SELECT * FROM dashboard_events").all();
    expect(events).toHaveLength(0);
  });
});
