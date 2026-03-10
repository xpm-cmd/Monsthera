import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { registerTicketTools } from "../../../src/tools/ticket-tools.js";
import { CoordinationBus } from "../../../src/coordination/bus.js";

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
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), from_status TEXT, to_status TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, comment TEXT, timestamp TEXT NOT NULL);
    CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE coordination_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), message_id TEXT NOT NULL UNIQUE, from_agent_id TEXT NOT NULL, to_agent_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE dashboard_events (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), event_type TEXT NOT NULL, data_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("ticket tools", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let repoId: number;
  let bus: CoordinationBus;
  const now = new Date().toISOString();

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    bus = new CoordinationBus("hub-spoke", 200, db, repoId);

    for (const agent of [
      { id: "agent-dev", name: "Dev", roleId: "developer", trustTier: "A" },
      { id: "agent-review", name: "Review", roleId: "reviewer", trustTier: "A" },
      { id: "agent-obs", name: "Obs", roleId: "observer", trustTier: "B" },
      { id: "agent-admin", name: "Admin", roleId: "admin", trustTier: "A" },
    ]) {
      queries.upsertAgent(db, {
        id: agent.id,
        name: agent.name,
        type: "test",
        roleId: agent.roleId as "developer" | "reviewer" | "observer" | "admin",
        trustTier: agent.trustTier as "A" | "B",
        registeredAt: now,
      });
    }

    for (const session of [
      { id: "session-dev", agentId: "agent-dev" },
      { id: "session-review", agentId: "agent-review" },
      { id: "session-obs", agentId: "agent-obs" },
      { id: "session-admin", agentId: "agent-admin" },
    ]) {
      queries.insertSession(db, {
        id: session.id,
        agentId: session.agentId,
        state: "active",
        connectedAt: now,
        lastActivity: now,
      });
    }

    server = new FakeServer();
    registerTicketTools(server as unknown as McpServer, async () => ({
      db,
      repoId,
      repoPath: "/test",
      insight: { info: () => undefined, warn: () => undefined },
      bus,
    } as any));
  });

  afterEach(() => sqlite.close());

  function handler(name: string) {
    const found = server.handlers.get(name);
    expect(found).toBeTypeOf("function");
    return found!;
  }

  function createTicket(overrides: Record<string, unknown> = {}) {
    return handler("create_ticket")({
      title: "Ticket title",
      description: "Ticket description",
      severity: "high",
      priority: 7,
      tags: ["bug", "ui"],
      affectedPaths: ["src/dashboard/html.ts"],
      acceptanceCriteria: "Ship it",
      agentId: "agent-review",
      sessionId: "session-review",
      ...overrides,
    });
  }

  it("creates a ticket and writes initial history", async () => {
    const result = await createTicket();
    const payload = JSON.parse(result.content[0].text);
    const ticket = queries.getTicketByTicketId(db, payload.ticketId)!;

    expect(payload.status).toBe("backlog");
    expect(ticket.commitSha).toBe("abc1234");
    expect(queries.getTicketHistory(db, ticket.id)).toHaveLength(1);
    expect(queries.getDashboardEventsByRepo(db, repoId)).toHaveLength(1);
    const coordination = bus.getMessages("agent-dev");
    expect(coordination).toHaveLength(1);
    expect(coordination[0]?.payload).toMatchObject({ domain: "ticket", eventType: "ticket_created" });
  });

  it("denies observer from creating tickets", async () => {
    const result = await createTicket({ agentId: "agent-obs", sessionId: "session-obs" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not have access to create_ticket");
  });

  it("allows developer self-assignment from backlog", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const assignResult = await handler("assign_ticket")({
      ticketId,
      assigneeAgentId: "agent-dev",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = JSON.parse(assignResult.content[0].text);
    const ticket = queries.getTicketByTicketId(db, ticketId)!;
    expect(payload.status).toBe("assigned");
    expect(ticket.assigneeAgentId).toBe("agent-dev");
  });

  it("denies developer assigning another agent", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const assignResult = await handler("assign_ticket")({
      ticketId,
      assigneeAgentId: "agent-review",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(assignResult.isError).toBe(true);
    expect(assignResult.content[0].text).toContain("Developers can only self-assign");
  });

  it("updates status, writes history, and clears resolvedByAgentId on reopen", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("assign_ticket")({
      ticketId,
      assigneeAgentId: "agent-dev",
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
      comment: "Ready for QA",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    await handler("update_ticket_status")({
      ticketId,
      status: "resolved",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    let ticket = queries.getTicketByTicketId(db, ticketId)!;
    expect(ticket.resolvedByAgentId).toBe("agent-review");

    await handler("update_ticket_status")({
      ticketId,
      status: "in_progress",
      comment: "Regression found",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    ticket = queries.getTicketByTicketId(db, ticketId)!;
    expect(ticket.status).toBe("in_progress");
    expect(ticket.resolvedByAgentId).toBeNull();
    expect(queries.getTicketHistory(db, ticket.id)).toHaveLength(6);
  });

  it("rejects invalid status transitions", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const result = await handler("update_ticket_status")({
      ticketId,
      status: "resolved",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid transition");
  });

  it("allows creator developer to update metadata and blocks non-creators", async () => {
    const createResult = await handler("create_ticket")({
      title: "Dev ticket",
      description: "Initial",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const updateResult = await handler("update_ticket")({
      ticketId,
      title: "Updated title",
      tags: ["backend"],
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(updateResult.isError).not.toBe(true);
    expect(queries.getTicketByTicketId(db, ticketId)?.title).toBe("Updated title");

    const denied = await handler("update_ticket")({
      ticketId,
      title: "Nope",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(denied.isError).toBe(true);
  });

  it("lists tickets with auth and tag filtering", async () => {
    await createTicket({ title: "Bug 1", tags: ["bug"] });
    await createTicket({ title: "Bug 2", tags: ["bug", "ui"] });
    await createTicket({ title: "Other", tags: ["other"] });

    const result = await handler("list_tickets")({
      agentId: "agent-dev",
      sessionId: "session-dev",
      tags: ["bug"],
      limit: 2,
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.count).toBe(2);
    expect(payload.tickets.every((ticket: { title: string }) => ticket.title.includes("Bug"))).toBe(true);
  });

  it("returns ticket detail with linked patches and comments", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;
    const ticket = queries.getTicketByTicketId(db, ticketId)!;

    queries.insertTicketComment(db, {
      ticketId: ticket.id,
      agentId: "agent-review",
      sessionId: "session-review",
      content: "Context",
      createdAt: now,
    });
    queries.insertPatch(db, {
      repoId,
      proposalId: "patch-1",
      baseCommit: "abc1234",
      state: "validated",
      diff: "---",
      message: "Fix",
      agentId: "agent-dev",
      sessionId: "session-dev",
      ticketId: ticket.id,
      createdAt: now,
      updatedAt: now,
    });

    const result = await handler("get_ticket")({
      ticketId,
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.comments).toHaveLength(1);
    expect(payload.linkedPatches).toHaveLength(1);
  });

  it("allows reviewer comments and denies observer comments", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const okResult = await handler("comment_ticket")({
      ticketId,
      content: "Needs more context",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(okResult.isError).not.toBe(true);
    expect(queries.getTicketComments(db, queries.getTicketByTicketId(db, ticketId)!.id)).toHaveLength(1);

    const denied = await handler("comment_ticket")({
      ticketId,
      content: "Observer note",
      agentId: "agent-obs",
      sessionId: "session-obs",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("does not have access");
  });
});
