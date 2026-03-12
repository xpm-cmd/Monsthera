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
  type TicketServiceContext,
  type TicketSystemContext,
  updateTicketStatusRecord,
} from "../../../src/tickets/service.js";
import { CoordinationBus } from "../../../src/coordination/bus.js";
import { FTS5Backend } from "../../../src/search/fts5.js";

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
    CREATE TABLE review_verdicts (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, specialization TEXT NOT NULL, verdict TEXT NOT NULL, reasoning TEXT, created_at TEXT NOT NULL, UNIQUE(ticket_id, specialization));
    CREATE TABLE ticket_dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, from_ticket_id INTEGER NOT NULL REFERENCES tickets(id), to_ticket_id INTEGER NOT NULL REFERENCES tickets(id), relation_type TEXT NOT NULL, created_by_agent_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE coordination_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), message_id TEXT NOT NULL UNIQUE, from_agent_id TEXT NOT NULL, to_agent_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE dashboard_events (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), event_type TEXT NOT NULL, data_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT, status TEXT NOT NULL DEFAULT 'active', agent_id TEXT, session_id TEXT, embedding BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE VIRTUAL TABLE knowledge_fts USING fts5(knowledge_id UNINDEXED, title, content, type UNINDEXED, tags);
    CREATE VIRTUAL TABLE tickets_fts USING fts5(ticket_id UNINDEXED, title, description, tags, status UNINDEXED, content='');
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

function registerActor(
  db: ReturnType<typeof createTestDb>["db"],
  input: { agentId: string; sessionId: string; roleId: "developer" | "reviewer" | "admin" },
) {
  const now = new Date().toISOString();
  queries.upsertAgent(db, {
    id: input.agentId,
    name: input.agentId,
    type: "test",
    roleId: input.roleId,
    trustTier: "A",
    registeredAt: now,
  });
  queries.insertSession(db, {
    id: input.sessionId,
    agentId: input.agentId,
    state: "active",
    connectedAt: now,
    lastActivity: now,
    claimedFilesJson: null,
  });
}

function recordVerdict(
  db: ReturnType<typeof createTestDb>["db"],
  ticketInternalId: number,
  input: {
    specialization: "architect" | "simplifier" | "security" | "performance" | "patterns" | "design";
    verdict: "pass" | "fail" | "abstain";
    agentId?: string;
    sessionId?: string;
    reasoning?: string;
  },
) {
  queries.upsertReviewVerdict(db, {
    ticketId: ticketInternalId,
    agentId: input.agentId ?? `agent-${input.specialization}`,
    sessionId: input.sessionId ?? `session-${input.specialization}`,
    specialization: input.specialization,
    verdict: input.verdict,
    reasoning: input.reasoning ?? null,
    createdAt: new Date().toISOString(),
  });
}

describe("ticket service system context", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let repoId: number;
  let bus: CoordinationBus;
  let refreshCount: number;
  let knowledgeRefreshCount: number;
  let knowledgeFts: FTS5Backend;
  let ctx: TicketSystemContext;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    bus = new CoordinationBus("hub-spoke", 200, db, repoId);
    refreshCount = 0;
    knowledgeRefreshCount = 0;
    knowledgeFts = new FTS5Backend(sqlite, db);
    knowledgeFts.initKnowledgeFts(sqlite);

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
      refreshKnowledgeSearch: () => {
        knowledgeRefreshCount += 1;
        knowledgeFts.rebuildKnowledgeFts(sqlite);
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
    const commentCreatedAt = commentResult.ok ? String(commentResult.data.createdAt) : "";

    const updated = queries.getTicketByTicketId(db, ticketId)!;
    const comments = queries.getTicketComments(db, ticket.id);
    const events = queries.getDashboardEventsByRepo(db, repoId);
    const messages = bus.getMessages("agent-dev");

    expect(updated.assigneeAgentId).toBe("agent-dev");
    expect(updated.status).toBe("technical_analysis");
    expect(updated.updatedAt).toBe(commentCreatedAt);
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

  it("captures repo knowledge automatically when resolving a ticket", async () => {
    const createResult = await createTicketRecord(ctx, {
      title: "Index stale after commit",
      description: "Resolving tickets should persist the distilled fix as searchable repo knowledge.",
      severity: "high",
      priority: 7,
      tags: ["knowledge", "automation"],
      affectedPaths: ["src/tickets/service.ts", "src/knowledge/search.ts"],
      acceptanceCriteria: "Knowledge entry exists",
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const ticketId = createResult.data.ticketId as string;
    const ticket = queries.getTicketByTicketId(db, ticketId)!;

    queries.insertPatch(db, {
      repoId,
      proposalId: "patch_knowledge_1",
      baseCommit: "abc1234",
      bundleId: null,
      state: "committed",
      diff: "--- a/src/tickets/service.ts",
      message: "Persist ticket learnings after resolution",
      touchedPathsJson: JSON.stringify(["src/tickets/service.ts"]),
      dryRunResultJson: null,
      agentId: "system:cli-admin",
      sessionId: "system",
      committedSha: "def5678",
      ticketId: ticket.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(updateTicketStatusRecord(ctx, {
      ticketId,
      status: "technical_analysis",
      comment: "Ready for resolution capture.",
    }).ok).toBe(true);

    const result = updateTicketStatusRecord(ctx, {
      ticketId,
      status: "resolved",
      comment: "Root cause fixed and captured.",
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toMatchObject({
      knowledgeCaptured: true,
      knowledgeKey: `solution:ticket:${ticketId.toLowerCase()}`,
    });
    expect(knowledgeRefreshCount).toBe(1);

    const knowledge = queries.getKnowledgeByKey(db, `solution:ticket:${ticketId.toLowerCase()}`);
    expect(knowledge).toBeTruthy();
    expect(knowledge?.title).toContain(ticketId);
    expect(knowledge?.content).toContain("Problem Summary");
    expect(knowledge?.content).toContain("Resolution Summary");
    expect(knowledge?.content).toContain("patch_knowledge_1 [committed]: Persist ticket learnings after resolution");
    expect(knowledge?.content).toContain("src/tickets/service.ts");
    expect(JSON.parse(knowledge?.tagsJson ?? "[]")).toEqual(["knowledge", "automation", "ticket-resolution"]);

    const results = knowledgeFts.searchKnowledge(sqlite, ticketId, 10);
    expect(results.some((entry) => entry.knowledgeId === knowledge?.id)).toBe(true);
  });

  it("updates the same knowledge entry on close and supports skipKnowledgeCapture", async () => {
    const createResult = await createTicketRecord(ctx, {
      title: "Heartbeat timeout follow-up",
      description: "Use one deterministic key for repeated post-resolution knowledge capture.",
      severity: "medium",
      priority: 4,
      tags: ["sessions"],
      affectedPaths: ["src/core/constants.ts"],
      acceptanceCriteria: "Upsert same key",
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    const ticketId = createResult.data.ticketId as string;

    expect(updateTicketStatusRecord(ctx, {
      ticketId,
      status: "technical_analysis",
      comment: "Ready for first capture.",
    }).ok).toBe(true);

    expect(updateTicketStatusRecord(ctx, {
      ticketId,
      status: "resolved",
      comment: "Resolved with first capture.",
    }).ok).toBe(true);

    const first = queries.getKnowledgeByKey(db, `solution:ticket:${ticketId.toLowerCase()}`);
    expect(first).toBeTruthy();

    expect(updateTicketStatusRecord(ctx, {
      ticketId,
      status: "closed",
      comment: "Closed after verification.",
    }).ok).toBe(true);

    const entries = queries.queryKnowledge(db, { status: "active", type: "solution" })
      .filter((entry) => entry.key === `solution:ticket:${ticketId.toLowerCase()}`);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.content).toContain("Final status: closed");
    expect(entries[0]?.content).toContain("Closed after verification.");

    const createSkipped = await createTicketRecord(ctx, {
      title: "Skip auto capture",
      description: "Explicit opt-out should avoid creating repo knowledge.",
      severity: "low",
      priority: 2,
      tags: [],
      affectedPaths: [],
      acceptanceCriteria: "No knowledge row",
    });
    expect(createSkipped.ok).toBe(true);
    if (!createSkipped.ok) return;
    const skippedTicketId = createSkipped.data.ticketId as string;

    expect(updateTicketStatusRecord(ctx, {
      ticketId: skippedTicketId,
      status: "technical_analysis",
      comment: "Ready to resolve without capture.",
    }).ok).toBe(true);

    const skipped = updateTicketStatusRecord(ctx, {
      ticketId: skippedTicketId,
      status: "resolved",
      comment: "Resolved without capture.",
      skipKnowledgeCapture: true,
    });
    expect(skipped.ok).toBe(true);
    expect(skipped.ok && skipped.data).toMatchObject({
      knowledgeCaptured: false,
      knowledgeKey: null,
    });
    expect(queries.getKnowledgeByKey(db, `solution:ticket:${skippedTicketId.toLowerCase()}`)).toBeUndefined();
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

  it("does not resolve or mutate tickets outside the active repo", () => {
    const otherRepoId = queries.upsertRepo(db, "/other", "other").id;
    const now = new Date().toISOString();
    queries.insertTicket(db, {
      repoId: otherRepoId,
      ticketId: "TKT-foreign01",
      title: "Foreign ticket",
      description: "Should stay hidden",
      status: "backlog",
      severity: "medium",
      priority: 5,
      creatorAgentId: "agent-dev",
      creatorSessionId: "session-dev",
      commitSha: "abc1234",
      createdAt: now,
      updatedAt: now,
    });

    const assignResult = assignTicketRecord(ctx, {
      ticketId: "TKT-foreign01",
      assigneeAgentId: "agent-dev",
    });
    const statusResult = updateTicketStatusRecord(ctx, {
      ticketId: "TKT-foreign01",
      status: "technical_analysis",
    });
    const commentResult = commentTicketRecord(ctx, {
      ticketId: "TKT-foreign01",
      content: "Should fail",
    });

    expect(assignResult.ok).toBe(false);
    expect(statusResult.ok).toBe(false);
    expect(commentResult.ok).toBe(false);
    expect(assignResult.ok ? "" : assignResult.code).toBe("not_found");
    expect(statusResult.ok ? "" : statusResult.code).toBe("not_found");
    expect(commentResult.ok ? "" : commentResult.code).toBe("not_found");
    expect(queries.getDashboardEventsByRepo(db, repoId)).toHaveLength(0);
    expect(bus.getMessages("agent-dev")).toHaveLength(0);
    expect(refreshCount).toBe(0);
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

describe("ticket service quorum enforcement", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let repoId: number;
  let reviewerCtx: TicketServiceContext;
  let adminCtx: TicketServiceContext;
  let systemCtx: TicketSystemContext;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;

    registerActor(db, { agentId: "agent-review", sessionId: "session-review", roleId: "reviewer" });
    registerActor(db, { agentId: "agent-admin", sessionId: "session-admin", roleId: "admin" });

    reviewerCtx = {
      db,
      repoId,
      repoPath: "/test",
      insight: { info: () => undefined, warn: () => undefined },
    };

    adminCtx = {
      ...reviewerCtx,
    };

    systemCtx = {
      ...reviewerCtx,
      system: true,
      actorLabel: "cli admin",
    };
  });

  afterEach(() => sqlite.close());

  async function createTechnicalAnalysisTicket() {
    const created = await createTicketRecord(systemCtx, {
      title: "Consensus gate",
      description: "Needs council consensus before approval",
      severity: "high",
      priority: 8,
      tags: ["quorum"],
      affectedPaths: ["src/tickets/service.ts"],
      acceptanceCriteria: "Consensus passes",
    });
    expect(created.ok).toBe(true);
    const ticketId = created.ok ? String(created.data.ticketId) : "";
    expect(updateTicketStatusRecord(systemCtx, {
      ticketId,
      status: "technical_analysis",
      comment: "Ready for council review",
    }).ok).toBe(true);
    const ticket = queries.getTicketByTicketId(db, ticketId)!;
    return { ticketId, ticket };
  }

  it("blocks technical_analysis→approved when quorum is not met and returns structured details", async () => {
    const { ticketId, ticket } = await createTechnicalAnalysisTicket();

    recordVerdict(db, ticket.id, {
      specialization: "architect",
      verdict: "pass",
      agentId: "agent-review",
      sessionId: "session-review",
      reasoning: "Foundations are sound",
    });

    const result = updateTicketStatusRecord(reviewerCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe("invalid_request");
    expect(result.message).toContain("Council quorum not met");
    expect(result.message).toContain("1/4 passes");
    expect(result.message).toContain("3 more needed");
    expect(result.message).toContain("Await verdicts from:");
    expect(result.data).toMatchObject({
      transition: "technical_analysis→approved",
      requiredPasses: 4,
      passesNeeded: 3,
      quorumMet: false,
      blockedByVeto: false,
      counts: {
        pass: 1,
        fail: 0,
        abstain: 0,
        responded: 1,
        missing: 5,
      },
    });
    expect(result.data?.missingSpecializations).toEqual(expect.arrayContaining([
      "simplifier",
      "security",
      "performance",
      "patterns",
      "design",
    ]));
    expect(result.data?.verdicts).toHaveLength(1);
    expect(queries.getTicketByTicketId(db, ticketId)?.status).toBe("technical_analysis");
  });

  it("blocks technical_analysis→approved when there are zero verdicts", async () => {
    const { ticketId } = await createTechnicalAnalysisTicket();

    const result = updateTicketStatusRecord(reviewerCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.message).toContain("Council quorum not met");
    expect(result.data).toMatchObject({
      counts: {
        pass: 0,
        fail: 0,
        abstain: 0,
        responded: 0,
        missing: 6,
      },
      quorumMet: false,
      blockedByVeto: false,
    });
  });

  it("allows technical_analysis→approved once quorum is met", async () => {
    const { ticketId, ticket } = await createTechnicalAnalysisTicket();

    for (const specialization of ["architect", "simplifier", "performance", "patterns"] as const) {
      recordVerdict(db, ticket.id, {
        specialization,
        verdict: "pass",
      });
    }

    const result = updateTicketStatusRecord(reviewerCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.ok).toBe(true);
    expect(queries.getTicketByTicketId(db, ticketId)?.status).toBe("approved");
  });

  it("blocks approval when architect or security veto exists even if pass quorum is met", async () => {
    const { ticketId, ticket } = await createTechnicalAnalysisTicket();

    for (const specialization of ["architect", "simplifier", "performance", "patterns"] as const) {
      recordVerdict(db, ticket.id, {
        specialization,
        verdict: "pass",
      });
    }
    recordVerdict(db, ticket.id, {
      specialization: "security",
      verdict: "fail",
      reasoning: "Threat model incomplete",
    });

    const result = updateTicketStatusRecord(reviewerCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.message).toContain("Council veto blocks");
    expect(result.message).toContain("security by");
    expect(result.message).toContain("Threat model incomplete");
    expect(result.message).toContain("clear the veto");
    expect(result.data).toMatchObject({
      quorumMet: true,
      blockedByVeto: true,
    });
    expect(result.data?.vetoes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        specialization: "security",
        verdict: "fail",
      }),
    ]));
    expect(queries.getTicketByTicketId(db, ticketId)?.status).toBe("technical_analysis");
  });

  it("blocks approval when the council only abstains", async () => {
    const { ticketId, ticket } = await createTechnicalAnalysisTicket();

    for (const specialization of ["architect", "simplifier", "security", "performance", "patterns", "design"] as const) {
      recordVerdict(db, ticket.id, {
        specialization,
        verdict: "abstain",
      });
    }

    const result = updateTicketStatusRecord(reviewerCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.data).toMatchObject({
      counts: {
        pass: 0,
        fail: 0,
        abstain: 6,
        responded: 6,
        missing: 0,
      },
      quorumMet: false,
      blockedByVeto: false,
    });
  });

  it("does not treat security abstain as a veto when quorum passes", async () => {
    const { ticketId, ticket } = await createTechnicalAnalysisTicket();

    for (const specialization of ["architect", "simplifier", "performance", "patterns"] as const) {
      recordVerdict(db, ticket.id, {
        specialization,
        verdict: "pass",
      });
    }
    recordVerdict(db, ticket.id, {
      specialization: "security",
      verdict: "abstain",
    });

    const result = updateTicketStatusRecord(reviewerCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.ok).toBe(true);
    expect(queries.getTicketByTicketId(db, ticketId)?.status).toBe("approved");
  });

  it("allows admin bypass when consensus is missing", async () => {
    const { ticketId } = await createTechnicalAnalysisTicket();

    const result = updateTicketStatusRecord(adminCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-admin",
      sessionId: "session-admin",
    });

    expect(result.ok).toBe(true);
    expect(queries.getTicketByTicketId(db, ticketId)?.status).toBe("approved");
  });

  it("uses configured quorum rules for in_review→ready_for_commit", async () => {
    const quorumCtx: TicketServiceContext = {
      ...reviewerCtx,
      ticketQuorum: {
        technicalAnalysisToApproved: {
          enabled: true,
          requiredPasses: 1,
          vetoSpecializations: ["architect", "security"],
        },
        inReviewToReadyForCommit: {
          enabled: true,
          requiredPasses: 2,
          vetoSpecializations: ["security"],
        },
      },
    };

    const created = await createTicketRecord(systemCtx, {
      title: "Review-ready ticket",
      description: "Uses a lower ready_for_commit threshold",
      severity: "medium",
      priority: 5,
      tags: ["quorum"],
      affectedPaths: ["src/core/config.ts"],
      acceptanceCriteria: "Config override applies",
    });
    expect(created.ok).toBe(true);
    const ticketId = created.ok ? String(created.data.ticketId) : "";

    expect(updateTicketStatusRecord(systemCtx, {
      ticketId,
      status: "technical_analysis",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(quorumCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    }).ok).toBe(false);

    const ticket = queries.getTicketByTicketId(db, ticketId)!;
    recordVerdict(db, ticket.id, { specialization: "architect", verdict: "pass" });

    expect(updateTicketStatusRecord(quorumCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(systemCtx, {
      ticketId,
      status: "in_review",
    }).ok).toBe(true);

    recordVerdict(db, ticket.id, { specialization: "simplifier", verdict: "pass" });

    const ready = updateTicketStatusRecord(quorumCtx, {
      ticketId,
      status: "ready_for_commit",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(ready.ok).toBe(true);
    expect(queries.getTicketByTicketId(db, ticketId)?.status).toBe("ready_for_commit");
  });

  it("does not fetch verdicts for non-gated transitions", async () => {
    const devCtx: TicketServiceContext = {
      ...reviewerCtx,
    };
    registerActor(db, { agentId: "agent-dev", sessionId: "session-dev", roleId: "developer" });

    const created = await createTicketRecord(systemCtx, {
      title: "Non-gated transition",
      description: "Should not consult council verdicts",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      acceptanceCriteria: null,
    });
    expect(created.ok).toBe(true);
    const ticketId = created.ok ? String(created.data.ticketId) : "";

    expect(updateTicketStatusRecord(systemCtx, {
      ticketId,
      status: "technical_analysis",
    }).ok).toBe(true);

    const ticket = queries.getTicketByTicketId(db, ticketId)!;
    for (const specialization of ["architect", "simplifier", "performance", "patterns"] as const) {
      recordVerdict(db, ticket.id, { specialization, verdict: "pass" });
    }

    expect(updateTicketStatusRecord(reviewerCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    }).ok).toBe(true);
    expect(assignTicketRecord(systemCtx, {
      ticketId,
      assigneeAgentId: "agent-dev",
    }).ok).toBe(true);

    const verdictSpy = vi.spyOn(queries, "getReviewVerdicts");
    const result = updateTicketStatusRecord(devCtx, {
      ticketId,
      status: "in_progress",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.ok).toBe(true);
    expect(verdictSpy).not.toHaveBeenCalled();
    verdictSpy.mockRestore();
  });
});

describe("ticket service governance: facilitator non-voting", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let repoId: number;
  let reviewerCtx: TicketServiceContext;
  let governanceCtx: TicketServiceContext;
  let systemCtx: TicketSystemContext;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;

    registerActor(db, { agentId: "agent-review", sessionId: "session-review", roleId: "reviewer" });

    // Register a facilitator agent with identity metadata
    const now = new Date().toISOString();
    queries.upsertAgent(db, {
      id: "agent-facilitator",
      name: "facilitator",
      type: "test",
      roleId: "facilitator",
      trustTier: "A",
      registeredAt: now,
      provider: "anthropic",
      model: "opus",
    });
    queries.insertSession(db, {
      id: "session-facilitator",
      agentId: "agent-facilitator",
      state: "active",
      connectedAt: now,
      lastActivity: now,
      claimedFilesJson: null,
    });

    reviewerCtx = {
      db,
      repoId,
      repoPath: "/test",
      insight: { info: () => undefined, warn: () => undefined },
    };

    governanceCtx = {
      ...reviewerCtx,
      governance: {
        nonVotingRoles: ["facilitator"],
        modelDiversity: { strict: false },
      },
    };

    systemCtx = {
      ...reviewerCtx,
      system: true,
      actorLabel: "cli admin",
    };
  });

  afterEach(() => sqlite.close());

  it("excludes facilitator verdicts from quorum when governance is configured", async () => {
    const created = await createTicketRecord(systemCtx, {
      title: "Governance gate",
      description: "Facilitator verdict should not count",
      severity: "high",
      priority: 8,
      tags: [],
      affectedPaths: [],
      acceptanceCriteria: null,
    });
    expect(created.ok).toBe(true);
    const ticketId = created.ok ? String(created.data.ticketId) : "";
    expect(updateTicketStatusRecord(systemCtx, {
      ticketId,
      status: "technical_analysis",
    }).ok).toBe(true);
    const ticket = queries.getTicketByTicketId(db, ticketId)!;

    // Facilitator submits architect verdict + 3 other passes = 4 total, but only 3 eligible
    recordVerdict(db, ticket.id, { specialization: "architect", verdict: "pass", agentId: "agent-facilitator", sessionId: "session-facilitator" });
    recordVerdict(db, ticket.id, { specialization: "simplifier", verdict: "pass" });
    recordVerdict(db, ticket.id, { specialization: "security", verdict: "pass" });
    recordVerdict(db, ticket.id, { specialization: "performance", verdict: "pass" });

    // With governance: facilitator excluded → only 3 passes, needs 4
    const result = updateTicketStatusRecord(governanceCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("quorum not met");
    }

    // Without governance: all 4 count → passes
    const resultNoGov = updateTicketStatusRecord(reviewerCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(resultNoGov.ok).toBe(true);
  });
});
