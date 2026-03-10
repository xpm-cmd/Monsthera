import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../src/db/schema.js";
import * as queries from "../../src/db/queries.js";
import { registerTicketTools } from "../../src/tools/ticket-tools.js";
import { registerPatchTools } from "../../src/tools/patch-tools.js";
import { validatePatch } from "../../src/patches/validator.js";

vi.mock("../../src/git/operations.js", () => ({
  getHead: vi.fn().mockResolvedValue("abc1234"),
}));

vi.mock("../../src/patches/validator.js", () => ({
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
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), from_status TEXT, to_status TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, comment TEXT, timestamp TEXT NOT NULL);
    CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("ticket lifecycle", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let repoId: number;
  const now = new Date().toISOString();

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;

    for (const agent of [
      { id: "agent-dev", name: "Dev", roleId: "developer", trustTier: "A" },
      { id: "agent-review", name: "Review", roleId: "reviewer", trustTier: "A" },
    ]) {
      queries.upsertAgent(db, {
        id: agent.id,
        name: agent.name,
        type: "test",
        roleId: agent.roleId as "developer" | "reviewer",
        trustTier: agent.trustTier as "A",
        registeredAt: now,
      });
    }

    queries.insertSession(db, {
      id: "session-dev",
      agentId: "agent-dev",
      state: "active",
      connectedAt: now,
      lastActivity: now,
    });
    queries.insertSession(db, {
      id: "session-review",
      agentId: "agent-review",
      state: "active",
      connectedAt: now,
      lastActivity: now,
    });

    server = new FakeServer();
    registerTicketTools(server as unknown as McpServer, async () => ({
      db,
      repoId,
      repoPath: "/test",
      insight: { info: () => undefined, warn: () => undefined },
    } as any));
    registerPatchTools(server as unknown as McpServer, async () => ({
      db,
      repoId,
      repoPath: "/test",
      insight: { info: () => undefined, warn: () => undefined },
    } as any));

    vi.mocked(validatePatch).mockResolvedValue({
      proposalId: "patch-123",
      valid: true,
      stale: false,
      currentHead: "abc1234",
      dryRunResult: {
        feasible: true,
        touchedPaths: ["src/dashboard/html.ts"],
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

  function handler(name: string) {
    const found = server.handlers.get(name);
    expect(found).toBeTypeOf("function");
    return found!;
  }

  it("runs a full reviewer → developer → reviewer lifecycle with linked patch", async () => {
    const created = await handler("create_ticket")({
      title: "Show comments in dashboard",
      description: "Need a detail view in the tickets tab",
      severity: "high",
      priority: 8,
      tags: ["dashboard", "tickets"],
      affectedPaths: ["src/dashboard/html.ts"],
      acceptanceCriteria: "Comments visible in dashboard",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const ticketId = JSON.parse(created.content[0].text).ticketId;

    await handler("comment_ticket")({
      ticketId,
      content: "Reviewer context",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    await handler("assign_ticket")({
      ticketId,
      assigneeAgentId: "agent-dev",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    await handler("comment_ticket")({
      ticketId,
      content: "Developer clarification request",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    await handler("update_ticket_status")({
      ticketId,
      status: "in_progress",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    await handler("update_ticket_status")({
      ticketId,
      status: "in_review",
      comment: "Ready for review",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    await handler("propose_patch")({
      diff: "--- a/src/dashboard/html.ts\n+++ b/src/dashboard/html.ts\n@@ -1 +1 @@\n-old\n+new",
      message: "Add dashboard ticket comments",
      baseCommit: "abc1234",
      agentId: "agent-dev",
      sessionId: "session-dev",
      ticketId,
    });
    await handler("update_ticket_status")({
      ticketId,
      status: "resolved",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    const detail = await handler("get_ticket")({
      ticketId,
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const list = await handler("list_tickets")({
      agentId: "agent-review",
      sessionId: "session-review",
      status: "resolved",
    });

    const detailPayload = JSON.parse(detail.content[0].text);
    const listPayload = JSON.parse(list.content[0].text);

    expect(detailPayload.status).toBe("resolved");
    expect(detailPayload.history).toHaveLength(5);
    expect(detailPayload.comments).toHaveLength(2);
    expect(detailPayload.linkedPatches).toHaveLength(1);
    expect(detailPayload.linkedPatches[0].proposalId).toBe("patch-123");
    expect(listPayload.tickets.map((ticket: { ticketId: string }) => ticket.ticketId)).toContain(ticketId);
  });
});
