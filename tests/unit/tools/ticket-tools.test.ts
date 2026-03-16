import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { registerTicketTools } from "../../../src/tools/ticket-tools.js";
import { CoordinationBus } from "../../../src/coordination/bus.js";
import { FTS5Backend } from "../../../src/search/fts5.js";
import { MAX_TICKET_LONG_TEXT_LENGTH } from "../../../src/core/input-hardening.js";

vi.mock("../../../src/git/operations.js", () => ({
  getHead: vi.fn().mockResolvedValue("abc1234"),
}));

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<any>>();
  schemas = new Map<string, Record<string, { safeParse: (input: unknown) => { success: boolean } }>>();

  tool(name: string, _description: string, schema: object, handler: (input: unknown) => Promise<any>) {
    this.handlers.set(name, handler);
    this.schemas.set(name, schema as Record<string, { safeParse: (input: unknown) => { success: boolean } }>);
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
    CREATE TABLE ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), from_status TEXT, to_status TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, comment TEXT, timestamp TEXT NOT NULL);
    CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE review_verdicts (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, specialization TEXT NOT NULL, verdict TEXT NOT NULL, reasoning TEXT, created_at TEXT NOT NULL, superseded_by INTEGER);
    CREATE TABLE council_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, specialization TEXT NOT NULL, assigned_by_agent_id TEXT NOT NULL, assigned_at TEXT NOT NULL, UNIQUE(ticket_id, specialization));
    CREATE TABLE ticket_dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, from_ticket_id INTEGER NOT NULL REFERENCES tickets(id), to_ticket_id INTEGER NOT NULL REFERENCES tickets(id), relation_type TEXT NOT NULL, created_by_agent_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE coordination_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), message_id TEXT NOT NULL UNIQUE, from_agent_id TEXT NOT NULL, to_agent_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE dashboard_events (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), event_type TEXT NOT NULL, data_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT, status TEXT NOT NULL DEFAULT 'active', agent_id TEXT, session_id TEXT, embedding BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE VIRTUAL TABLE knowledge_fts USING fts5(knowledge_id UNINDEXED, title, content, type UNINDEXED, tags);
    CREATE TABLE IF NOT EXISTS work_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), group_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL, tags_json TEXT, current_wave INTEGER, integration_branch TEXT, wave_plan_json TEXT, launched_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_group_tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, work_group_id INTEGER NOT NULL REFERENCES work_groups(id), ticket_id INTEGER NOT NULL REFERENCES tickets(id), wave_number INTEGER, wave_status TEXT DEFAULT 'pending', added_at TEXT NOT NULL, UNIQUE(work_group_id, ticket_id));
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
        upsertKnowledgeFts: (_targetSqlite: InstanceType<typeof Database>, knowledgeId: number) =>
          fts5.upsertKnowledgeFts(sqlite, knowledgeId),
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

  function buildVerdictReasoning(
    specialization: "architect" | "simplifier" | "security" | "performance" | "patterns" | "design",
    verdict: "pass" | "fail" | "abstain" = "pass",
    path = "src/dashboard/html.ts",
  ) {
    return `${specialization} ${verdict} review references ${path} and explains the concrete ${specialization} concerns for this ticket in code terms.`;
  }

  async function grantAdvisoryQuorum(ticketId: string) {
    for (const specialization of ["architect", "simplifier", "performance", "patterns"] as const) {
      const result = await handler("submit_verdict")({
        ticketId,
        specialization,
        verdict: "pass",
        reasoning: buildVerdictReasoning(specialization),
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

  it("enforces the backlog planning gate before entering technical_analysis", async () => {
    config.governance = {
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: true, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
      backlogPlanningGate: { enforce: true, minIterations: 3, requiredDistinctModels: 2 },
      requireBinding: false,
      autoAdvance: true,
    };

    queries.upsertAgent(db, {
      ...(queries.getAgent(db, "agent-review") ?? {
        id: "agent-review",
        name: "Review",
        type: "test",
        roleId: "reviewer",
        trustTier: "A",
        registeredAt: now,
      }),
      provider: "openai",
      model: "gpt-5",
    });
    queries.upsertAgent(db, {
      ...(queries.getAgent(db, "agent-admin") ?? {
        id: "agent-admin",
        name: "Admin",
        type: "test",
        roleId: "admin",
        trustTier: "A",
        registeredAt: now,
      }),
      provider: "anthropic",
      model: "sonnet",
    });

    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const blocked = await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toContain("Backlog planning gate not met");

    for (const [agentId, sessionId, content] of [
      ["agent-review", "session-review", "[Technical Analysis]\nSummary\nDraft one"],
      ["agent-admin", "session-admin", "[Plan Review]\nRisks\nDraft two"],
      ["agent-review", "session-review", "[Plan Iteration]\nRevision\nDraft three"],
    ] as const) {
      const comment = await handler("comment_ticket")({
        ticketId,
        content,
        agentId,
        sessionId,
      });
      expect(comment.isError).not.toBe(true);
    }

    const allowed = await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(allowed.isError).not.toBe(true);
    const payload = JSON.parse(allowed.content[0].text);
    expect(payload.status).toBe("technical_analysis");
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

  it("allows privileged actors to clear a stale assignee through assign_ticket", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("assign_ticket")({
      ticketId,
      assigneeAgentId: "agent-dev",
      agentId: "agent-admin",
      sessionId: "session-admin",
    });

    const clearResult = await handler("assign_ticket")({
      ticketId,
      assigneeAgentId: null,
      agentId: "agent-admin",
      sessionId: "session-admin",
    });

    expect(clearResult.isError).toBeFalsy();
    const payload = JSON.parse(clearResult.content[0].text);
    expect(payload.assigneeAgentId).toBeNull();
    expect(queries.getTicketByTicketId(db, ticketId)?.assigneeAgentId).toBeNull();
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

  it("rejects entering in_progress without an assignee unless autoAssign is requested", async () => {
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

    const result = await handler("update_ticket_status")({
      ticketId,
      status: "in_progress",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Cannot move to in_progress without an assignee");
    expect(queries.getTicketByTicketId(db, ticketId)?.status).toBe("approved");
    expect(queries.getTicketByTicketId(db, ticketId)?.assigneeAgentId).toBeNull();
  });

  it("supports explicit autoAssign when a non-system actor enters in_progress", async () => {
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

    const result = await handler("update_ticket_status")({
      ticketId,
      status: "in_progress",
      autoAssign: true,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.assigneeAgentId).toBe("agent-dev");
    expect(queries.getTicketByTicketId(db, ticketId)?.status).toBe("in_progress");
    expect(queries.getTicketByTicketId(db, ticketId)?.assigneeAgentId).toBe("agent-dev");
  });

  it("updates status, writes history, and clears resolvedByAgentId on reopen", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;
    const createdTicket = queries.getTicketByTicketId(db, ticketId)!;
    queries.updateTicket(db, createdTicket.id, { commitSha: "stale000" });

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
    await grantAdvisoryQuorum(ticketId);
    await handler("update_ticket_status")({
      ticketId,
      status: "ready_for_commit",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    let ticket = queries.getTicketByTicketId(db, ticketId)!;
    expect(ticket.resolvedByAgentId).toBeNull();

    await handler("comment_ticket")({
      ticketId,
      content: "Verified: implementation looks correct",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    await handler("update_ticket_status")({
      ticketId,
      status: "resolved",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    ticket = queries.getTicketByTicketId(db, ticketId)!;
    expect(ticket.resolvedByAgentId).toBe("agent-dev");
    expect(ticket.commitSha).toBe("abc1234");

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

  it("uses the shared long-text limit across ticket create, update, comment, and verdict schemas", () => {
    const createSchema = server.schemas.get("create_ticket")!;
    const updateSchema = server.schemas.get("update_ticket")!;
    const commentSchema = server.schemas.get("comment_ticket")!;
    const verdictSchema = server.schemas.get("submit_verdict")!;
    const validLongText = "x".repeat(MAX_TICKET_LONG_TEXT_LENGTH);
    const tooLongText = "x".repeat(MAX_TICKET_LONG_TEXT_LENGTH + 1);
    const createAcceptance = createSchema.acceptanceCriteria!;
    const updateAcceptance = updateSchema.acceptanceCriteria!;
    const commentContent = commentSchema.content!;
    const verdictReasoning = verdictSchema.reasoning!;

    expect(createAcceptance.safeParse(validLongText).success).toBe(true);
    expect(createAcceptance.safeParse(tooLongText).success).toBe(false);
    expect(updateAcceptance.safeParse(validLongText).success).toBe(true);
    expect(updateAcceptance.safeParse(tooLongText).success).toBe(false);
    expect(commentContent.safeParse(validLongText).success).toBe(true);
    expect(commentContent.safeParse(tooLongText).success).toBe(false);
    expect(verdictReasoning.safeParse(validLongText).success).toBe(true);
    expect(verdictReasoning.safeParse(tooLongText).success).toBe(false);
  });

  it("rejects pass verdicts with short reasoning", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const result = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      reasoning: "Short src/a.ts",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("at least 50 characters");
  });

  it("allows short abstain reasoning", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const result = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "abstain",
      reasoning: "Need more data",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.isError).not.toBe(true);
  });

  it("emits a dashboard event when a verdict is submitted", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const result = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      reasoning: buildVerdictReasoning("architect"),
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.isError).not.toBe(true);

    const latestEvent = queries.getDashboardEventsByRepo(db, repoId).at(-1);
    expect(latestEvent?.eventType).toBe("ticket_verdict_submitted");
    expect(JSON.parse(latestEvent?.dataJson ?? "{}")).toMatchObject({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      agentId: "agent-review",
    });
  });

  it("rejects template-only verdict reasoning", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const result = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      reasoning: "Autonomous council review for technical_analysis→approved. Ticket: Example. Changed files: 3.",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("too generic");
  });

  it("rejects duplicate reasoning across specializations for the same agent", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;
    const duplicatedReasoning = buildVerdictReasoning("architect", "pass", "src/shared/review.ts");

    const first = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      reasoning: duplicatedReasoning,
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(first.isError).not.toBe(true);

    const second = await handler("submit_verdict")({
      ticketId,
      specialization: "security",
      verdict: "pass",
      reasoning: duplicatedReasoning,
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain("Each specialization needs distinct analysis");
  });

  it("records advisory verdicts and reports consensus state", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const architect = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      reasoning: buildVerdictReasoning("architect"),
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const security = await handler("submit_verdict")({
      ticketId,
      specialization: "security",
      verdict: "fail",
      reasoning: buildVerdictReasoning("security", "fail", "src/auth/guard.ts"),
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

  it("assigns council specializations per ticket", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const result = await handler("assign_council")({
      ticketId,
      councilAgentId: "agent-review",
      specialization: "architect",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.assignment).toMatchObject({
      agentId: "agent-review",
      specialization: "architect",
      assignedByAgentId: "agent-dev",
    });

    const ticket = queries.getTicketByTicketId(db, ticketId)!;
    expect(queries.getCouncilAssignment(db, ticket.id, "agent-review", "architect")).toBeTruthy();
  });

  it("rejects council assignment to agents that cannot submit verdicts", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const denied = await handler("assign_council")({
      ticketId,
      councilAgentId: "agent-obs",
      specialization: "design",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("cannot serve as a council reviewer");
  });

  it("uses configured quorum rules for transition-aware verdict and consensus reports", async () => {
    config.ticketQuorum = {
      enabled: true,
      requiredPasses: 2,
      vetoSpecializations: ["security"],
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
      reasoning: buildVerdictReasoning("architect"),
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

  it("reports governed ticket consensus against the 5 analytical specializations", async () => {
    config.governance = {
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: false, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
    };

    for (const [agentId, provider, model] of [
      ["agent-review", "openai", "gpt-5"],
      ["agent-dev", "anthropic", "sonnet"],
      ["agent-dev-2", "google", "gemini"],
      ["agent-admin", "meta", "llama"],
    ] as const) {
      queries.upsertAgent(db, {
        ...(queries.getAgent(db, agentId) ?? {
          id: agentId,
          name: agentId,
          type: "test",
          roleId: agentId === "agent-admin" ? "admin" : agentId === "agent-review" ? "reviewer" : "developer",
          trustTier: "A",
          registeredAt: now,
        }),
        provider,
        model,
      });
    }

    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    const reviewers = [
      { specialization: "architect" as const, agentId: "agent-review", sessionId: "session-review" },
      { specialization: "simplifier" as const, agentId: "agent-dev", sessionId: "session-dev" },
      { specialization: "security" as const, agentId: "agent-dev-2", sessionId: "session-dev-2" },
      { specialization: "performance" as const, agentId: "agent-admin", sessionId: "session-admin" },
    ];
    for (const reviewer of reviewers) {
      const verdictResult = await handler("submit_verdict")({
        ticketId,
        specialization: reviewer.specialization,
        verdict: "pass",
        reasoning: buildVerdictReasoning(reviewer.specialization),
        agentId: reviewer.agentId,
        sessionId: reviewer.sessionId,
      });
      expect(verdictResult.isError).not.toBe(true);
    }

    const consensus = await handler("check_consensus")({
      ticketId,
      transition: "technical_analysis→approved",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(consensus.isError).not.toBe(true);

    const payload = JSON.parse(consensus.content[0].text);
    expect(payload.councilSpecializations).toEqual([
      "architect",
      "simplifier",
      "security",
      "performance",
      "patterns",
    ]);
    expect(payload.counts).toMatchObject({
      pass: 4,
      fail: 0,
      abstain: 0,
      responded: 4,
      missing: 1,
    });
    expect(payload.missingSpecializations).toEqual(["patterns"]);
  });

  it("keeps verdict history while consensus reads only the active verdict", async () => {
    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      reasoning: buildVerdictReasoning("architect", "pass", "src/layout/root.ts"),
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const replacement = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "fail",
      reasoning: buildVerdictReasoning("architect", "fail", "src/layout/root.ts"),
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    const payload = JSON.parse(replacement.content[0].text);

    expect(payload.verdict).toMatchObject({
      specialization: "architect",
      verdict: "fail",
      agentId: "agent-dev",
      reasoning: buildVerdictReasoning("architect", "fail", "src/layout/root.ts"),
    });

    const ticket = queries.getTicketByTicketId(db, ticketId)!;
    const verdicts = queries.getActiveReviewVerdicts(db, ticket.id);
    const history = queries.getVerdictHistory(db, ticket.id, "architect");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      specialization: "architect",
      verdict: "fail",
      agentId: "agent-dev",
    });
    expect(history).toHaveLength(2);
    expect(history[0]?.supersededBy).toBe(history[1]?.id);
    expect(history[1]?.supersededBy).toBeNull();
  });

  it("enforces council binding when governance.requireBinding is enabled", async () => {
    config.governance = {
      requireBinding: true,
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: false, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
    };

    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const denied = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("is not assigned as architect");

    const assigned = await handler("assign_council")({
      ticketId,
      councilAgentId: "agent-review",
      specialization: "architect",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    expect(assigned.isError).not.toBe(true);

    const allowed = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      reasoning: buildVerdictReasoning("architect"),
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(allowed.isError).not.toBe(true);
  });

  it("allows admin to bypass council binding enforcement", async () => {
    config.governance = {
      requireBinding: true,
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: false, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
    };

    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const allowed = await handler("submit_verdict")({
      ticketId,
      specialization: "security",
      verdict: "pass",
      reasoning: buildVerdictReasoning("security"),
      agentId: "agent-admin",
      sessionId: "session-admin",
    });

    expect(allowed.isError).not.toBe(true);
    const payload = JSON.parse(allowed.content[0].text);
    expect(payload.verdict).toMatchObject({
      specialization: "security",
      agentId: "agent-admin",
    });
  });

  it("blocks consensus when non-critical reviewers use the same model, even with distinct agents", async () => {
    config.governance = {
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: true, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
      requireBinding: false,
      autoAdvance: true,
    };

    for (const [agentId, sessionId] of [["agent-review", "session-review"], ["agent-dev", "session-dev"], ["agent-dev-2", "session-dev-2"], ["agent-admin", "session-admin"]] as const) {
      queries.upsertAgent(db, {
        ...(queries.getAgent(db, agentId) ?? {
          id: agentId,
          name: agentId,
          type: "test",
          roleId: agentId === "agent-admin" ? "admin" : agentId === "agent-review" ? "reviewer" : "developer",
          trustTier: "A",
          registeredAt: now,
        }),
        provider: agentId === "agent-admin" ? "anthropic" : "openai",
        model: agentId === "agent-admin" ? "opus" : "gpt-5",
      });
      if (!queries.getSession(db, sessionId)) {
        queries.insertSession(db, {
          id: sessionId,
          agentId,
          state: "active",
          connectedAt: now,
          lastActivity: now,
        });
      }
    }

    const createResult = await createTicket({ severity: "high" });
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    for (const reviewer of [
      { specialization: "architect" as const, agentId: "agent-review", sessionId: "session-review" },
      { specialization: "simplifier" as const, agentId: "agent-dev", sessionId: "session-dev" },
      { specialization: "security" as const, agentId: "agent-dev-2", sessionId: "session-dev-2" },
      { specialization: "performance" as const, agentId: "agent-admin", sessionId: "session-admin" },
    ]) {
      const verdictResult = await handler("submit_verdict")({
        ticketId,
        specialization: reviewer.specialization,
        verdict: "pass",
        reasoning: buildVerdictReasoning(reviewer.specialization),
        agentId: reviewer.agentId,
        sessionId: reviewer.sessionId,
      });
      expect(verdictResult.isError).not.toBe(true);
    }

    const consensus = await handler("check_consensus")({
      ticketId,
      transition: "technical_analysis→approved",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(consensus.isError).not.toBe(true);
    const payload = JSON.parse(consensus.content[0].text);
    expect(payload.quorumMet).toBe(false);
    expect(payload.advisoryReady).toBe(false);
    expect(payload.governance.modelDiversity.diversityMet).toBe(false);
  });

  it("waives same-model blocking for critical tickets while keeping distinct agents", async () => {
    config.governance = {
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: true, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
      requireBinding: false,
      autoAdvance: true,
    };

    for (const [agentId, sessionId] of [["agent-review", "session-review"], ["agent-dev", "session-dev"], ["agent-dev-2", "session-dev-2"], ["agent-admin", "session-admin"]] as const) {
      queries.upsertAgent(db, {
        ...(queries.getAgent(db, agentId) ?? {
          id: agentId,
          name: agentId,
          type: "test",
          roleId: agentId === "agent-admin" ? "admin" : agentId === "agent-review" ? "reviewer" : "developer",
          trustTier: "A",
          registeredAt: now,
        }),
        provider: agentId === "agent-admin" ? "anthropic" : "openai",
        model: agentId === "agent-admin" ? "opus" : "gpt-5",
      });
      if (!queries.getSession(db, sessionId)) {
        queries.insertSession(db, {
          id: sessionId,
          agentId,
          state: "active",
          connectedAt: now,
          lastActivity: now,
        });
      }
    }

    const createResult = await createTicket({ severity: "critical" });
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    let lastPayload: any = null;
    for (const reviewer of [
      { specialization: "architect" as const, agentId: "agent-review", sessionId: "session-review" },
      { specialization: "simplifier" as const, agentId: "agent-dev", sessionId: "session-dev" },
      { specialization: "security" as const, agentId: "agent-dev-2", sessionId: "session-dev-2" },
      { specialization: "performance" as const, agentId: "agent-admin", sessionId: "session-admin" },
    ]) {
      const verdictResult = await handler("submit_verdict")({
        ticketId,
        specialization: reviewer.specialization,
        verdict: "pass",
        reasoning: buildVerdictReasoning(reviewer.specialization),
        agentId: reviewer.agentId,
        sessionId: reviewer.sessionId,
      });
      expect(verdictResult.isError).not.toBe(true);
      lastPayload = JSON.parse(verdictResult.content[0].text);
    }

    expect(lastPayload.consensus.quorumMet).toBe(true);
    expect(lastPayload.consensus.advisoryReady).toBe(true);
    expect(lastPayload.autoAdvanced).toMatchObject({
      previousStatus: "technical_analysis",
      status: "approved",
    });
  });

  it("skips auto-advance for tickets tagged with excluded tags (umbrella, tracking, discussion)", async () => {
    config.governance = {
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: true, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
      requireBinding: false,
      autoAdvance: true,
      autoAdvanceExcludedTags: ["umbrella", "tracking", "discussion"],
    };

    for (const [agentId, sessionId] of [["agent-review", "session-review"], ["agent-dev", "session-dev"], ["agent-dev-2", "session-dev-2"], ["agent-admin", "session-admin"]] as const) {
      queries.upsertAgent(db, {
        ...(queries.getAgent(db, agentId) ?? {
          id: agentId,
          name: agentId,
          type: "test",
          roleId: agentId === "agent-admin" ? "admin" : agentId === "agent-review" ? "reviewer" : "developer",
          trustTier: "A",
          registeredAt: now,
        }),
        provider: agentId === "agent-admin" ? "anthropic" : "openai",
        model: agentId === "agent-admin" ? "opus" : "gpt-5",
      });
      if (!queries.getSession(db, sessionId)) {
        queries.insertSession(db, {
          id: sessionId,
          agentId,
          state: "active",
          connectedAt: now,
          lastActivity: now,
        });
      }
    }

    const createResult = await createTicket({ tags: ["umbrella", "governance"], severity: "critical" });
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    let lastPayload: any = null;
    for (const reviewer of [
      { specialization: "architect" as const, agentId: "agent-review", sessionId: "session-review" },
      { specialization: "simplifier" as const, agentId: "agent-dev", sessionId: "session-dev" },
      { specialization: "security" as const, agentId: "agent-dev-2", sessionId: "session-dev-2" },
      { specialization: "performance" as const, agentId: "agent-admin", sessionId: "session-admin" },
    ]) {
      const verdictResult = await handler("submit_verdict")({
        ticketId,
        specialization: reviewer.specialization,
        verdict: "pass",
        reasoning: buildVerdictReasoning(reviewer.specialization),
        agentId: reviewer.agentId,
        sessionId: reviewer.sessionId,
      });
      expect(verdictResult.isError).not.toBe(true);
      lastPayload = JSON.parse(verdictResult.content[0].text);
    }

    expect(lastPayload.consensus.quorumMet).toBe(true);
    expect(lastPayload.consensus.advisoryReady).toBe(true);
    expect(lastPayload.autoAdvanced).toBeNull();

    const ticket = queries.getTicketByTicketId(db, ticketId)!;
    expect(ticket.status).toBe("technical_analysis");
  });

  it("auto-advances normal tickets even when excluded tags exist in config", async () => {
    config.governance = {
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: true, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
      requireBinding: false,
      autoAdvance: true,
      autoAdvanceExcludedTags: ["umbrella", "tracking", "discussion"],
    };

    for (const [agentId, sessionId] of [["agent-review", "session-review"], ["agent-dev", "session-dev"], ["agent-dev-2", "session-dev-2"], ["agent-admin", "session-admin"]] as const) {
      queries.upsertAgent(db, {
        ...(queries.getAgent(db, agentId) ?? {
          id: agentId,
          name: agentId,
          type: "test",
          roleId: agentId === "agent-admin" ? "admin" : agentId === "agent-review" ? "reviewer" : "developer",
          trustTier: "A",
          registeredAt: now,
        }),
        provider: agentId === "agent-admin" ? "anthropic" : "openai",
        model: agentId === "agent-admin" ? "opus" : "gpt-5",
      });
      if (!queries.getSession(db, sessionId)) {
        queries.insertSession(db, {
          id: sessionId,
          agentId,
          state: "active",
          connectedAt: now,
          lastActivity: now,
        });
      }
    }

    const createResult = await createTicket({ tags: ["bug", "governance"], severity: "critical" });
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    let lastPayload: any = null;
    for (const reviewer of [
      { specialization: "architect" as const, agentId: "agent-review", sessionId: "session-review" },
      { specialization: "simplifier" as const, agentId: "agent-dev", sessionId: "session-dev" },
      { specialization: "security" as const, agentId: "agent-dev-2", sessionId: "session-dev-2" },
      { specialization: "performance" as const, agentId: "agent-admin", sessionId: "session-admin" },
    ]) {
      const verdictResult = await handler("submit_verdict")({
        ticketId,
        specialization: reviewer.specialization,
        verdict: "pass",
        reasoning: buildVerdictReasoning(reviewer.specialization),
        agentId: reviewer.agentId,
        sessionId: reviewer.sessionId,
      });
      expect(verdictResult.isError).not.toBe(true);
      lastPayload = JSON.parse(verdictResult.content[0].text);
    }

    expect(lastPayload.consensus.quorumMet).toBe(true);
    expect(lastPayload.consensus.advisoryReady).toBe(true);
    expect(lastPayload.autoAdvanced).toMatchObject({
      previousStatus: "technical_analysis",
      status: "approved",
    });
  });

  it("skips auto-advance for tickets tagged with no-advance", async () => {
    config.governance = {
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: true, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
      requireBinding: false,
      autoAdvance: true,
      autoAdvanceExcludedTags: ["umbrella", "tracking", "discussion", "no-advance"],
    };

    for (const [agentId, sessionId] of [["agent-review", "session-review"], ["agent-dev", "session-dev"], ["agent-dev-2", "session-dev-2"], ["agent-admin", "session-admin"]] as const) {
      queries.upsertAgent(db, {
        ...(queries.getAgent(db, agentId) ?? {
          id: agentId,
          name: agentId,
          type: "test",
          roleId: agentId === "agent-admin" ? "admin" : agentId === "agent-review" ? "reviewer" : "developer",
          trustTier: "A",
          registeredAt: now,
        }),
        provider: agentId === "agent-admin" ? "anthropic" : "openai",
        model: agentId === "agent-admin" ? "opus" : "gpt-5",
      });
      if (!queries.getSession(db, sessionId)) {
        queries.insertSession(db, {
          id: sessionId,
          agentId,
          state: "active",
          connectedAt: now,
          lastActivity: now,
        });
      }
    }

    const createResult = await createTicket({ tags: ["no-advance", "feature"], severity: "critical" });
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    let lastPayload: any = null;
    for (const reviewer of [
      { specialization: "architect" as const, agentId: "agent-review", sessionId: "session-review" },
      { specialization: "simplifier" as const, agentId: "agent-dev", sessionId: "session-dev" },
      { specialization: "security" as const, agentId: "agent-dev-2", sessionId: "session-dev-2" },
      { specialization: "performance" as const, agentId: "agent-admin", sessionId: "session-admin" },
    ]) {
      const verdictResult = await handler("submit_verdict")({
        ticketId,
        specialization: reviewer.specialization,
        verdict: "pass",
        reasoning: buildVerdictReasoning(reviewer.specialization),
        agentId: reviewer.agentId,
        sessionId: reviewer.sessionId,
      });
      expect(verdictResult.isError).not.toBe(true);
      lastPayload = JSON.parse(verdictResult.content[0].text);
    }

    expect(lastPayload.consensus.quorumMet).toBe(true);
    expect(lastPayload.consensus.advisoryReady).toBe(true);
    expect(lastPayload.autoAdvanced).toBeNull();

    const ticket = queries.getTicketByTicketId(db, ticketId)!;
    expect(ticket.status).toBe("technical_analysis");
  });

  it("auto-advances tickets without excluded tags when quorum is met (no-advance regression)", async () => {
    config.governance = {
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: true, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
      requireBinding: false,
      autoAdvance: true,
      autoAdvanceExcludedTags: ["umbrella", "tracking", "discussion", "no-advance"],
    };

    for (const [agentId, sessionId] of [["agent-review", "session-review"], ["agent-dev", "session-dev"], ["agent-dev-2", "session-dev-2"], ["agent-admin", "session-admin"]] as const) {
      queries.upsertAgent(db, {
        ...(queries.getAgent(db, agentId) ?? {
          id: agentId,
          name: agentId,
          type: "test",
          roleId: agentId === "agent-admin" ? "admin" : agentId === "agent-review" ? "reviewer" : "developer",
          trustTier: "A",
          registeredAt: now,
        }),
        provider: agentId === "agent-admin" ? "anthropic" : "openai",
        model: agentId === "agent-admin" ? "opus" : "gpt-5",
      });
      if (!queries.getSession(db, sessionId)) {
        queries.insertSession(db, {
          id: sessionId,
          agentId,
          state: "active",
          connectedAt: now,
          lastActivity: now,
        });
      }
    }

    const createResult = await createTicket({ tags: ["feature", "api"], severity: "critical" });
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    let lastPayload: any = null;
    for (const reviewer of [
      { specialization: "architect" as const, agentId: "agent-review", sessionId: "session-review" },
      { specialization: "simplifier" as const, agentId: "agent-dev", sessionId: "session-dev" },
      { specialization: "security" as const, agentId: "agent-dev-2", sessionId: "session-dev-2" },
      { specialization: "performance" as const, agentId: "agent-admin", sessionId: "session-admin" },
    ]) {
      const verdictResult = await handler("submit_verdict")({
        ticketId,
        specialization: reviewer.specialization,
        verdict: "pass",
        reasoning: buildVerdictReasoning(reviewer.specialization),
        agentId: reviewer.agentId,
        sessionId: reviewer.sessionId,
      });
      expect(verdictResult.isError).not.toBe(true);
      lastPayload = JSON.parse(verdictResult.content[0].text);
    }

    expect(lastPayload.consensus.quorumMet).toBe(true);
    expect(lastPayload.consensus.advisoryReady).toBe(true);
    expect(lastPayload.autoAdvanced).toMatchObject({
      previousStatus: "technical_analysis",
      status: "approved",
    });
  });

  it("denies a fourth same-model council voter even on critical tickets", async () => {
    config.governance = {
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: true, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
      requireBinding: false,
      autoAdvance: true,
    };

    for (const [agentId, sessionId] of [["agent-review", "session-review"], ["agent-dev", "session-dev"], ["agent-dev-2", "session-dev-2"], ["agent-admin", "session-admin"]] as const) {
      queries.upsertAgent(db, {
        ...(queries.getAgent(db, agentId) ?? {
          id: agentId,
          name: agentId,
          type: "test",
          roleId: agentId === "agent-admin" ? "admin" : agentId === "agent-review" ? "reviewer" : "developer",
          trustTier: "A",
          registeredAt: now,
        }),
        provider: "openai",
        model: "gpt-5",
      });
      if (!queries.getSession(db, sessionId)) {
        queries.insertSession(db, {
          id: sessionId,
          agentId,
          state: "active",
          connectedAt: now,
          lastActivity: now,
        });
      }
    }

    const createResult = await createTicket({ severity: "critical" });
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("update_ticket_status")({
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    for (const reviewer of [
      { specialization: "architect" as const, agentId: "agent-review", sessionId: "session-review" },
      { specialization: "simplifier" as const, agentId: "agent-dev", sessionId: "session-dev" },
      { specialization: "security" as const, agentId: "agent-dev-2", sessionId: "session-dev-2" },
    ]) {
      const verdictResult = await handler("submit_verdict")({
        ticketId,
        specialization: reviewer.specialization,
        verdict: "pass",
        reasoning: buildVerdictReasoning(reviewer.specialization),
        agentId: reviewer.agentId,
        sessionId: reviewer.sessionId,
      });
      expect(verdictResult.isError).not.toBe(true);
    }

    const denied = await handler("submit_verdict")({
      ticketId,
      specialization: "performance",
      verdict: "pass",
      reasoning: buildVerdictReasoning("performance"),
      agentId: "agent-admin",
      sessionId: "session-admin",
    });

    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("Model voter cap exceeded");
    expect(denied.content[0].text).toContain("\"validation\": \"model_voter_cap\"");
  });

  it("authorizes verdict via council_assignment when agent has assignment", async () => {
    config.governance = {
      requireBinding: false,
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: false, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
    };

    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    await handler("assign_council")({
      ticketId,
      councilAgentId: "agent-review",
      specialization: "architect",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const result = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      reasoning: buildVerdictReasoning("architect"),
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.verdictAuthorizedBy).toBe("council_assignment");
  });

  it("authorizes verdict via admin_override for admin agents", async () => {
    config.governance = {
      requireBinding: true,
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: false, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
    };

    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const result = await handler("submit_verdict")({
      ticketId,
      specialization: "security",
      verdict: "pass",
      reasoning: buildVerdictReasoning("security"),
      agentId: "agent-admin",
      sessionId: "session-admin",
    });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.verdictAuthorizedBy).toBe("admin_override");
  });

  it("authorizes verdict via binding_disabled when requireBinding is false and no assignment", async () => {
    config.governance = {
      requireBinding: false,
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: false, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
    };

    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const result = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      reasoning: buildVerdictReasoning("architect"),
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.isError).not.toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.verdictAuthorizedBy).toBe("binding_disabled");
  });

  it("rejects verdict when requireBinding is true and agent has no assignment", async () => {
    config.governance = {
      requireBinding: true,
      nonVotingRoles: ["facilitator"],
      modelDiversity: { strict: false, maxVotersPerModel: 3 },
      reviewerIndependence: { strict: true, identityKey: "agent" },
    };

    const createResult = await createTicket();
    const ticketId = JSON.parse(createResult.content[0].text).ticketId;

    const result = await handler("submit_verdict")({
      ticketId,
      specialization: "architect",
      verdict: "pass",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("is not assigned as architect");
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
