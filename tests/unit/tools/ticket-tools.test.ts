import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { registerTicketTools } from "../../../src/tools/ticket-tools.js";
import { CoordinationBus } from "../../../src/coordination/bus.js";
import { FTS5Backend } from "../../../src/search/fts5.js";

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
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), from_status TEXT, to_status TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, comment TEXT, timestamp TEXT NOT NULL);
    CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE review_verdicts (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, specialization TEXT NOT NULL, verdict TEXT NOT NULL, reasoning TEXT, created_at TEXT NOT NULL, UNIQUE(ticket_id, specialization));
    CREATE TABLE ticket_dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, from_ticket_id INTEGER NOT NULL REFERENCES tickets(id), to_ticket_id INTEGER NOT NULL REFERENCES tickets(id), relation_type TEXT NOT NULL, created_by_agent_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE coordination_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), message_id TEXT NOT NULL UNIQUE, from_agent_id TEXT NOT NULL, to_agent_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE dashboard_events (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), event_type TEXT NOT NULL, data_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT, status TEXT NOT NULL DEFAULT 'active', agent_id TEXT, session_id TEXT, embedding BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE VIRTUAL TABLE knowledge_fts USING fts5(knowledge_id UNINDEXED, title, content, type UNINDEXED, tags);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("ticket tools", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let repoId: number;
  let bus: CoordinationBus;
  let fts5: FTS5Backend;
  let config: { ticketQuorum?: Record<string, unknown>; governance?: Record<string, unknown> };
  const now = new Date().toISOString();

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    bus = new CoordinationBus("hub-spoke", 200, db, repoId);
    fts5 = new FTS5Backend(sqlite, db);
    fts5.initTicketFts();
    fts5.initKnowledgeFts(sqlite);
    config = {};

    for (const agent of [
      { id: "agent-dev", name: "Dev", roleId: "developer", trustTier: "A" },
      { id: "agent-dev-2", name: "Dev 2", roleId: "developer", trustTier: "A" },
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
      { id: "session-dev-2", agentId: "agent-dev-2" },
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
      sqlite,
      config,
      repoId,
      repoPath: "/test",
      insight: { info: () => undefined, warn: () => undefined },
      bus,
      searchRouter: {
        rebuildTicketFts: () => fts5.rebuildTicketFts(repoId),
        rebuildKnowledgeFts: () => fts5.rebuildKnowledgeFts(sqlite),
        searchTickets: (query: string, searchRepoId: number, limit?: number, opts?: {
          status?: string;
          severity?: string;
          assigneeAgentId?: string;
        }) => fts5.searchTickets(query, searchRepoId, limit, opts),
      },
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

  async function grantAdvisoryQuorum(ticketId: string) {
    for (const specialization of ["architect", "simplifier", "performance", "patterns"] as const) {
      const result = await handler("submit_verdict")({
        ticketId,
        specialization,
        verdict: "pass",
        agentId: "agent-review",
        sessionId: "session-review",
      });
      expect(result.isError).not.toBe(true);
    }
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
    expect(payload.status).toBe("backlog");
    expect(ticket.assigneeAgentId).toBe("agent-dev");
  });

  it("allows developer self-assignment from technical_analysis", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    const assignResult = await handler("assign_ticket")({
      ticketId,
      assigneeAgentId: "agent-dev",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = JSON.parse(assignResult.content[0].text);
    const ticket = queries.getTicketByTicketId(db, ticketId)!;
    expect(payload.status).toBe("technical_analysis");
    expect(ticket.assigneeAgentId).toBe("agent-dev");
    expect(queries.getTicketHistory(db, ticket.id).some((entry) => entry.toStatus === "technical_analysis")).toBe(true);
  });

  it("allows developer self-assignment from approved without changing status", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    await grantAdvisoryQuorum(ticketId);
    await handler("update_ticket_status")({
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    const assignResult = await handler("assign_ticket")({
      ticketId,
      assigneeAgentId: "agent-dev",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = JSON.parse(assignResult.content[0].text);
    const ticket = queries.getTicketByTicketId(db, ticketId)!;
    expect(payload.status).toBe("approved");
    expect(ticket.status).toBe("approved");
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

  it("denies developer reassigning a ticket owned by another developer", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const ownerAssign = await handler("assign_ticket")({
      ticketId,
      assigneeAgentId: "agent-dev",
      agentId: "agent-admin",
      sessionId: "session-admin",
    });
    expect(ownerAssign.isError).not.toBe(true);

    const reassignResult = await handler("assign_ticket")({
      ticketId,
      assigneeAgentId: "agent-dev-2",
      agentId: "agent-dev-2",
      sessionId: "session-dev-2",
    });

    expect(reassignResult.isError).toBe(true);
    expect(reassignResult.content[0].text).toContain("cannot reassign");
    expect(queries.getTicketByTicketId(db, ticketId)?.assigneeAgentId).toBe("agent-dev");
  });

  it("denies developer transitioning a ticket they do not own", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    await grantAdvisoryQuorum(ticketId);
    await handler("update_ticket_status")({
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    await handler("assign_ticket")({
      ticketId,
      assigneeAgentId: "agent-dev",
      agentId: "agent-admin",
      sessionId: "session-admin",
    });

    const result = await handler("update_ticket_status")({
      ticketId,
      status: "in_progress",
      agentId: "agent-dev-2",
      sessionId: "session-dev-2",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("assigned to themselves");
    expect(queries.getTicketByTicketId(db, ticketId)?.status).toBe("approved");
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
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    await grantAdvisoryQuorum(ticketId);
    await handler("update_ticket_status")({
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
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
      status: "ready_for_commit",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    let ticket = queries.getTicketByTicketId(db, ticketId)!;
    expect(ticket.resolvedByAgentId).toBeNull();

    await handler("update_ticket_status")({
      ticketId,
      status: "resolved",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    ticket = queries.getTicketByTicketId(db, ticketId)!;
    expect(ticket.resolvedByAgentId).toBe("agent-dev");

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
    expect(queries.getTicketHistory(db, ticket.id)).toHaveLength(8);
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

  it("scopes ticket tools to the active repo", async () => {
    const otherRepoId = queries.upsertRepo(db, "/other", "other").id;
    queries.insertTicket(db, {
      repoId: otherRepoId,
      ticketId: "TKT-foreign01",
      title: "Foreign ticket",
      description: "Hidden from this repo",
      status: "backlog",
      severity: "medium",
      priority: 5,
      creatorAgentId: "agent-review",
      creatorSessionId: "session-review",
      commitSha: "abc1234",
      createdAt: now,
      updatedAt: now,
    });

    const getResult = await handler("get_ticket")({
      ticketId: "TKT-foreign01",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(getResult.isError).toBe(true);
    expect(getResult.content[0].text).toContain("Ticket not found");

    const updateResult = await handler("update_ticket")({
      ticketId: "TKT-foreign01",
      title: "Nope",
      agentId: "agent-admin",
      sessionId: "session-admin",
    });
    expect(updateResult.isError).toBe(true);
    expect(updateResult.content[0].text).toContain("Ticket not found");

    const assignResult = await handler("assign_ticket")({
      ticketId: "TKT-foreign01",
      assigneeAgentId: "agent-dev",
      agentId: "agent-admin",
      sessionId: "session-admin",
    });
    expect(assignResult.isError).toBe(true);
    expect(assignResult.content[0].text).toContain("Ticket not found");
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

  it("falls back safely when stored ticket tag or path JSON is malformed", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    sqlite.prepare(
      "UPDATE tickets SET tags_json = ?, affected_paths_json = ? WHERE ticket_id = ?",
    ).run("{bad json", "{bad json", ticketId);

    const result = await handler("get_ticket")({
      ticketId,
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.tags).toEqual([]);
    expect(payload.affectedPaths).toEqual([]);
  });

  it("searches tickets via FTS with structured filters", async () => {
    await createTicket({
      title: "Dashboard repo name header",
      description: "Need search to find this by title",
      tags: ["dashboard", "search"],
    });
    const closed = await createTicket({
      title: "Dashboard search follow-up",
      description: "Same topic but resolved",
      tags: ["dashboard", "search"],
    });
    const closedTicketId = JSON.parse(closed.content[0].text).ticketId;
    await handler("update_ticket_status")({
      ticketId: closedTicketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    await handler("assign_ticket")({
      ticketId: closedTicketId,
      assigneeAgentId: "agent-dev",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    await handler("update_ticket_status")({
      ticketId: closedTicketId,
      status: "in_progress",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    await handler("update_ticket_status")({
      ticketId: closedTicketId,
      status: "in_review",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    await handler("update_ticket_status")({
      ticketId: closedTicketId,
      status: "ready_for_commit",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    await handler("update_ticket_status")({
      ticketId: closedTicketId,
      status: "resolved",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const result = await handler("search_tickets")({
      query: "repo name header",
      status: "backlog",
      agentId: "agent-dev",
      sessionId: "session-dev",
      limit: 10,
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.count).toBe(1);
    expect(payload.tickets[0].title).toContain("repo name header");
    expect(payload.tickets[0].status).toBe("backlog");
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

  it("records advisory verdicts and reports consensus state", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const architect = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      reasoning: "Architecture is sound",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const security = await handler("submit_verdict")({
      ticketId,
      specialization: "security",
      verdict: "fail",
      reasoning: "Auth boundary unresolved",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(architect.isError).not.toBe(true);
    expect(security.isError).not.toBe(true);

    const consensus = await handler("check_consensus")({
      ticketId,
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const payload = JSON.parse(consensus.content[0].text);

    expect(payload.requiredPasses).toBe(4);
    expect(payload.counts).toMatchObject({
      pass: 1,
      fail: 1,
      abstain: 0,
      responded: 2,
      missing: 4,
    });
    expect(payload.quorumMet).toBe(false);
    expect(payload.blockedByVeto).toBe(true);
    expect(payload.vetoes).toHaveLength(1);
    expect(payload.vetoes[0]).toMatchObject({
      specialization: "security",
      verdict: "fail",
    });
    expect(payload.missingSpecializations).toEqual(expect.arrayContaining([
      "simplifier",
      "performance",
      "patterns",
      "design",
    ]));
  });

  it("uses configured quorum rules for transition-aware verdict and consensus reports", async () => {
    config.ticketQuorum = {
      technicalAnalysisToApproved: {
        enabled: true,
        requiredPasses: 2,
        vetoSpecializations: ["security"],
      },
      inReviewToReadyForCommit: {
        enabled: true,
        requiredPasses: 3,
        vetoSpecializations: ["architect", "security"],
      },
    };

    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    const verdictResult = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(verdictResult.isError).not.toBe(true);

    const verdictPayload = JSON.parse(verdictResult.content[0].text);
    expect(verdictPayload.consensus).toMatchObject({
      transition: "technical_analysis→approved",
      enforcementEnabled: true,
      requiredPasses: 2,
      quorumMet: false,
      blockedByVeto: false,
      vetoSpecializations: ["security"],
    });

    const consensus = await handler("check_consensus")({
      ticketId,
      transition: "technical_analysis→approved",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(consensus.isError).not.toBe(true);
    const consensusPayload = JSON.parse(consensus.content[0].text);
    expect(consensusPayload).toMatchObject({
      transition: "technical_analysis→approved",
      enforcementEnabled: true,
      requiredPasses: 2,
      counts: {
        pass: 1,
        fail: 0,
        abstain: 0,
        responded: 1,
        missing: 5,
      },
      vetoSpecializations: ["security"],
    });
  });

  it("latest verdict per specialization wins", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      reasoning: "Initial pass",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const replacement = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "fail",
      reasoning: "Updated concern",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    const payload = JSON.parse(replacement.content[0].text);

    expect(payload.verdict).toMatchObject({
      specialization: "architect",
      verdict: "fail",
      agentId: "agent-dev",
      reasoning: "Updated concern",
    });

    const ticket = queries.getTicketByTicketId(db, ticketId)!;
    const verdicts = queries.getReviewVerdicts(db, ticket.id);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      specialization: "architect",
      verdict: "fail",
      agentId: "agent-dev",
    });
  });

  it("denies observer verdict submission", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const denied = await handler("submit_verdict")({
      ticketId,
      specialization: "design",
      verdict: "pass",
      agentId: "agent-obs",
      sessionId: "session-obs",
    });

    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("does not have access");
  });

  it("captures repo knowledge on resolve and supports skipKnowledgeCapture", async () => {
    const created = await handler("create_ticket")({
      title: "Auto capture knowledge",
      description: "Resolved tickets should create one deterministic repo knowledge entry.",
      severity: "medium",
      priority: 5,
      tags: ["knowledge"],
      affectedPaths: ["src/tools/ticket-tools.ts"],
      acceptanceCriteria: "Knowledge row exists",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const ticketId = JSON.parse(created.content[0].text).ticketId as string;

    await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      comment: "Ready to resolve",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    await handler("update_ticket_status")({
      ticketId,
      status: "resolved",
      comment: "Resolved and captured.",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    const knowledge = queries.getKnowledgeByKey(db, `solution:ticket:${ticketId.toLowerCase()}`);
    expect(knowledge?.content).toContain("Resolved and captured.");
    expect(knowledge?.content).toContain("Affected Paths");

    const skipped = await handler("create_ticket")({
      title: "Skip capture",
      description: "Skip should opt out of repo knowledge creation.",
      severity: "low",
      priority: 2,
      tags: [],
      affectedPaths: [],
      acceptanceCriteria: "No knowledge row",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const skippedTicketId = JSON.parse(skipped.content[0].text).ticketId as string;

    await handler("update_ticket_status")({
      ticketId: skippedTicketId,
      status: "technical_analysis",
      comment: "Ready to resolve",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    await handler("update_ticket_status")({
      ticketId: skippedTicketId,
      status: "resolved",
      comment: "No capture please.",
      skipKnowledgeCapture: true,
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(queries.getKnowledgeByKey(db, `solution:ticket:${skippedTicketId.toLowerCase()}`)).toBeUndefined();
  });
});
