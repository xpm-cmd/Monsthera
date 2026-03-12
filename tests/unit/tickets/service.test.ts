import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import {
  assignTicketRecord,
  batchCommentTickets,
  batchTransitionTickets,
  commentTicketRecord,
  createTicketRecord,
  type TicketSystemContext,
  updateTicketStatusRecord,
} from "../../../src/tickets/service.js";
import { CoordinationBus } from "../../../src/coordination/bus.js";

vi.mock("../../../src/git/operations.js", () => ({
  getHead: vi.fn().mockResolvedValue("abc1234"),
}));

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
    CREATE TABLE ticket_dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, from_ticket_id INTEGER NOT NULL REFERENCES tickets(id), to_ticket_id INTEGER NOT NULL REFERENCES tickets(id), relation_type TEXT NOT NULL, created_by_agent_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE coordination_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), message_id TEXT NOT NULL UNIQUE, from_agent_id TEXT NOT NULL, to_agent_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE dashboard_events (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), event_type TEXT NOT NULL, data_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE VIRTUAL TABLE tickets_fts USING fts5(ticket_id UNINDEXED, title, description, tags, status UNINDEXED, content='');
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("ticket service system context", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let repoId: number;
  let bus: CoordinationBus;
  let refreshCount: number;
  let ctx: TicketSystemContext;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    bus = new CoordinationBus("hub-spoke", 200, db, repoId);
    refreshCount = 0;

    queries.upsertAgent(db, {
      id: "agent-dev",
      name: "Dev",
      type: "test",
      roleId: "developer",
      trustTier: "A",
      registeredAt: new Date().toISOString(),
    });

    ctx = {
      db,
      repoId,
      repoPath: "/test",
      system: true,
      actorLabel: "cli admin",
      insight: { info: () => undefined, warn: () => undefined },
      bus,
      refreshTicketSearch: () => {
        refreshCount += 1;
      },
    };
  });

  afterEach(() => sqlite.close());

  it("creates, assigns, transitions, and comments with reserved system actor IDs", async () => {
    const createResult = await createTicketRecord(ctx, {
      title: "Batch cleanup",
      description: "Create a ticket from a CLI script",
      severity: "medium",
      priority: 9,
      tags: ["ops"],
      affectedPaths: ["src/tickets/service.ts"],
      acceptanceCriteria: "Done",
    });

    expect(createResult.ok).toBe(true);
    const ticketId = createResult.ok ? String(createResult.data.ticketId) : "";
    const ticket = queries.getTicketByTicketId(db, ticketId)!;
    const history = queries.getTicketHistory(db, ticket.id);
    expect(ticket.creatorAgentId).toBe("system:cli-admin");
    expect(ticket.creatorSessionId).toBe("system");
    expect(history[0]?.agentId).toBe("system:cli-admin");
    expect(history[0]?.sessionId).toBe("system");

    const assignResult = assignTicketRecord(ctx, {
      ticketId,
      assigneeAgentId: "agent-dev",
    });
    expect(assignResult.ok).toBe(true);

    const statusResult = updateTicketStatusRecord(ctx, {
      ticketId,
      status: "technical_analysis",
      comment: "Move into review prep",
    });
    expect(statusResult.ok).toBe(true);

    const commentResult = commentTicketRecord(ctx, {
      ticketId,
      content: "Triggered from system context.",
    });
    expect(commentResult.ok).toBe(true);
    expect(commentResult.ok ? commentResult.data.agentId : "").toBe("system:cli-admin");

    const updated = queries.getTicketByTicketId(db, ticketId)!;
    const comments = queries.getTicketComments(db, ticket.id);
    const events = queries.getDashboardEventsByRepo(db, repoId);
    const messages = bus.getMessages("agent-dev");

    expect(updated.assigneeAgentId).toBe("agent-dev");
    expect(updated.status).toBe("technical_analysis");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.agentId).toBe("system:cli-admin");
    expect(comments[0]?.sessionId).toBe("system");
    expect(events.map((event) => event.eventType)).toEqual([
      "ticket_created",
      "ticket_assigned",
      "ticket_status_changed",
      "ticket_commented",
    ]);
    expect(messages).toHaveLength(4);
    expect(messages.every((message) => message.from === "system:cli-admin")).toBe(true);
    expect(refreshCount).toBe(3);
  });

  it("still enforces transition validation in system context", async () => {
    const createResult = await createTicketRecord(ctx, {
      title: "Invalid transition check",
      description: "Ensure system mode does not bypass workflow rules",
      severity: "low",
      priority: 5,
      tags: [],
      affectedPaths: [],
      acceptanceCriteria: null,
    });
    expect(createResult.ok).toBe(true);
    const ticketId = createResult.ok ? String(createResult.data.ticketId) : "";
    const ticket = queries.getTicketByTicketId(db, ticketId)!;

    const transition = updateTicketStatusRecord(ctx, {
      ticketId,
      status: "resolved",
    });

    expect(transition.ok).toBe(false);
    expect(transition.ok ? "" : transition.code).toBe("invalid_request");
    expect(queries.getTicketHistory(db, ticket.id)).toHaveLength(1);
    expect(queries.getDashboardEventsByRepo(db, repoId)).toHaveLength(1);
    expect(bus.getMessages("agent-dev")).toHaveLength(1);
    expect(refreshCount).toBe(1);
  });

  it("rolls back ticket creation when history insert fails", async () => {
    sqlite.exec(`
      CREATE TRIGGER fail_ticket_history_insert
      BEFORE INSERT ON ticket_history
      BEGIN
        SELECT RAISE(FAIL, 'ticket history failed');
      END;
    `);

    await expect(createTicketRecord(ctx, {
      title: "Atomic create",
      description: "Should rollback the ticket insert",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      acceptanceCriteria: null,
    })).rejects.toThrow("ticket history failed");

    expect(queries.getTicketsByRepo(db, repoId)).toHaveLength(0);
    expect(queries.getDashboardEventsByRepo(db, repoId)).toHaveLength(0);
    expect(bus.getMessages("agent-dev")).toHaveLength(0);
    expect(refreshCount).toBe(0);
  });

  it("rolls back status updates when history insert fails", async () => {
    const createResult = await createTicketRecord(ctx, {
      title: "Atomic transition",
      description: "Status and history should commit together",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      acceptanceCriteria: null,
    });
    expect(createResult.ok).toBe(true);
    const ticketId = createResult.ok ? String(createResult.data.ticketId) : "";
    const ticket = queries.getTicketByTicketId(db, ticketId)!;

    sqlite.exec(`
      CREATE TRIGGER fail_ticket_history_transition
      BEFORE INSERT ON ticket_history
      WHEN NEW.from_status IS NOT NULL
      BEGIN
        SELECT RAISE(FAIL, 'transition history failed');
      END;
    `);

    expect(() => updateTicketStatusRecord(ctx, {
      ticketId,
      status: "technical_analysis",
      comment: "Should rollback",
    })).toThrowError("transition history failed");

    const unchanged = queries.getTicketByTicketId(db, ticketId)!;
    expect(unchanged.status).toBe("backlog");
    expect(queries.getTicketHistory(db, ticket.id)).toHaveLength(1);
  });

  it("batch transitions multiple tickets while preserving per-ticket workflow records", async () => {
    const first = await createTicketRecord(ctx, {
      title: "First batch ticket",
      description: "Batch status update target A",
      severity: "medium",
      priority: 8,
      tags: [],
      affectedPaths: [],
      acceptanceCriteria: null,
    });
    const second = await createTicketRecord(ctx, {
      title: "Second batch ticket",
      description: "Batch status update target B",
      severity: "medium",
      priority: 8,
      tags: [],
      affectedPaths: [],
      acceptanceCriteria: null,
    });
    const firstTicketId = first.ok ? String(first.data.ticketId) : "";
    const secondTicketId = second.ok ? String(second.data.ticketId) : "";

    const result = batchTransitionTickets(ctx, {
      actorLabel: "batch-runner",
      ticketIds: [firstTicketId, secondTicketId, firstTicketId],
      toStatus: "technical_analysis",
      comment: "Bulk triage",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.ok).toBe(true);
    expect(result.data.total).toBe(2);
    expect(result.data.succeeded).toBe(2);
    expect(result.data.failed).toBe(0);
    expect(result.data.results).toEqual([
      { ticketId: firstTicketId, ok: true },
      { ticketId: secondTicketId, ok: true },
    ]);

    const firstTicket = queries.getTicketByTicketId(db, firstTicketId)!;
    const secondTicket = queries.getTicketByTicketId(db, secondTicketId)!;
    expect(firstTicket.status).toBe("technical_analysis");
    expect(secondTicket.status).toBe("technical_analysis");

    const firstHistory = queries.getTicketHistory(db, firstTicket.id);
    const secondHistory = queries.getTicketHistory(db, secondTicket.id);
    expect(firstHistory).toHaveLength(2);
    expect(secondHistory).toHaveLength(2);
    expect(firstHistory[1]?.agentId).toBe("system:batch-runner");
    expect(secondHistory[1]?.agentId).toBe("system:batch-runner");
    expect(firstHistory[1]?.comment).toBe("Bulk triage");

    const events = queries.getDashboardEventsByRepo(db, repoId);
    expect(events.map((event) => event.eventType)).toEqual([
      "ticket_created",
      "ticket_created",
      "ticket_status_changed",
      "ticket_status_changed",
    ]);
    // 2 creates + 2 transitions (one per ticket, delegated to updateTicketStatusRecord)
    expect(refreshCount).toBe(4);
  });

  it("batch comments report partial failures without dropping successful writes", async () => {
    const created = await createTicketRecord(ctx, {
      title: "Comment target",
      description: "Valid ticket for batch comment",
      severity: "low",
      priority: 4,
      tags: [],
      affectedPaths: [],
      acceptanceCriteria: null,
    });
    const ticketId = created.ok ? String(created.data.ticketId) : "";
    const ticket = queries.getTicketByTicketId(db, ticketId)!;

    const result = batchCommentTickets(ctx, {
      actorLabel: "admin-batch",
      ticketIds: [ticketId, "TKT-missing"],
      content: "Batch note",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.ok).toBe(false);
    expect(result.data.total).toBe(2);
    expect(result.data.succeeded).toBe(1);
    expect(result.data.failed).toBe(1);
    expect(result.data.results).toEqual([
      { ticketId, ok: true },
      { ticketId: "TKT-missing", ok: false, error: "Ticket not found: TKT-missing" },
    ]);

    const comments = queries.getTicketComments(db, ticket.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.agentId).toBe("system:admin-batch");
    expect(comments[0]?.content).toBe("Batch note");
    const events = queries.getDashboardEventsByRepo(db, repoId);
    expect(events.map((event) => event.eventType)).toEqual([
      "ticket_created",
      "ticket_commented",
    ]);
  });

  it("supports the agreed recovery and non-implementation transitions", async () => {
    const planning = await createTicketRecord(ctx, {
      title: "Planning-only ticket",
      description: "Should resolve directly from technical analysis",
      severity: "low",
      priority: 3,
      tags: ["planning"],
      affectedPaths: [],
      acceptanceCriteria: null,
    });
    expect(planning.ok).toBe(true);
    const planningTicketId = planning.ok ? String(planning.data.ticketId) : "";

    expect(updateTicketStatusRecord(ctx, {
      ticketId: planningTicketId,
      status: "technical_analysis",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: planningTicketId,
      status: "resolved",
      comment: "Planning discussion concluded",
    }).ok).toBe(true);

    const reviewReady = await createTicketRecord(ctx, {
      title: "Already landed change",
      description: "Should move directly from approved to in_review",
      severity: "medium",
      priority: 6,
      tags: ["workflow"],
      affectedPaths: [],
      acceptanceCriteria: null,
    });
    expect(reviewReady.ok).toBe(true);
    const reviewReadyTicketId = reviewReady.ok ? String(reviewReady.data.ticketId) : "";

    expect(updateTicketStatusRecord(ctx, {
      ticketId: reviewReadyTicketId,
      status: "technical_analysis",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reviewReadyTicketId,
      status: "approved",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reviewReadyTicketId,
      status: "in_review",
      comment: "Change already landed, review directly",
    }).ok).toBe(true);

    const abandoned = await createTicketRecord(ctx, {
      title: "Abandoned blocked ticket",
      description: "Should return to backlog after wont_fix",
      severity: "medium",
      priority: 5,
      tags: ["workflow"],
      affectedPaths: [],
      acceptanceCriteria: null,
    });
    expect(abandoned.ok).toBe(true);
    const abandonedTicketId = abandoned.ok ? String(abandoned.data.ticketId) : "";

    expect(updateTicketStatusRecord(ctx, {
      ticketId: abandonedTicketId,
      status: "technical_analysis",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: abandonedTicketId,
      status: "approved",
    }).ok).toBe(true);
    expect(assignTicketRecord(ctx, {
      ticketId: abandonedTicketId,
      assigneeAgentId: "agent-dev",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: abandonedTicketId,
      status: "in_progress",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: abandonedTicketId,
      status: "blocked",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: abandonedTicketId,
      status: "wont_fix",
      comment: "Blocked by external constraint",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: abandonedTicketId,
      status: "backlog",
      comment: "Return for future re-triage",
    }).ok).toBe(true);

    const reopened = await createTicketRecord(ctx, {
      title: "Closed ticket reopened to backlog",
      description: "Should allow archival closure and later re-triage",
      severity: "high",
      priority: 7,
      tags: ["workflow"],
      affectedPaths: [],
      acceptanceCriteria: null,
    });
    expect(reopened.ok).toBe(true);
    const reopenedTicketId = reopened.ok ? String(reopened.data.ticketId) : "";

    expect(updateTicketStatusRecord(ctx, {
      ticketId: reopenedTicketId,
      status: "technical_analysis",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reopenedTicketId,
      status: "approved",
    }).ok).toBe(true);
    expect(assignTicketRecord(ctx, {
      ticketId: reopenedTicketId,
      assigneeAgentId: "agent-dev",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reopenedTicketId,
      status: "in_progress",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reopenedTicketId,
      status: "in_review",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reopenedTicketId,
      status: "ready_for_commit",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reopenedTicketId,
      status: "resolved",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reopenedTicketId,
      status: "closed",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reopenedTicketId,
      status: "backlog",
      comment: "Reopen after closure",
    }).ok).toBe(true);

    expect(queries.getTicketByTicketId(db, planningTicketId)?.status).toBe("resolved");
    expect(queries.getTicketByTicketId(db, reviewReadyTicketId)?.status).toBe("in_review");
    expect(queries.getTicketByTicketId(db, abandonedTicketId)?.status).toBe("backlog");
    expect(queries.getTicketByTicketId(db, reopenedTicketId)?.status).toBe("backlog");
  });
});
