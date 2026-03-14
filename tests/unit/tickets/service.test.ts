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
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT, worktree_path TEXT, worktree_branch TEXT);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, required_roles_json TEXT, resolution_commits_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), from_status TEXT, to_status TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, comment TEXT, timestamp TEXT NOT NULL);
    CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE review_verdicts (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, specialization TEXT NOT NULL, verdict TEXT NOT NULL, reasoning TEXT, created_at TEXT NOT NULL, superseded_by INTEGER);
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
  let knowledgeRefreshArgs: Array<number[] | undefined>;
  let knowledgeFts: FTS5Backend;
  let ctx: TicketSystemContext;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    bus = new CoordinationBus("hub-spoke", 200, db, repoId);
    refreshCount = 0;
    knowledgeRefreshCount = 0;
    knowledgeRefreshArgs = [];
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
      refreshKnowledgeSearch: (knowledgeIds) => {
        knowledgeRefreshCount += 1;
        knowledgeRefreshArgs.push(knowledgeIds);
        if (knowledgeIds && knowledgeIds.length > 0) {
          for (const knowledgeId of knowledgeIds) {
            knowledgeFts.upsertKnowledgeFts(sqlite, knowledgeId);
          }
          return;
        }
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

  it("allows privileged actors to clear a stale assignee", async () => {
    const createResult = await createTicketRecord(ctx, {
      title: "Clear stale owner",
      description: "Operator clears an orphaned assignee.",
      severity: "medium",
      priority: 6,
      tags: ["ops"],
      affectedPaths: [],
      acceptanceCriteria: null,
    });
    expect(createResult.ok).toBe(true);
    const ticketId = createResult.ok ? String(createResult.data.ticketId) : "";

    expect(assignTicketRecord(ctx, {
      ticketId,
      assigneeAgentId: "agent-dev",
    }).ok).toBe(true);

    const result = assignTicketRecord(ctx, {
      ticketId,
      assigneeAgentId: null,
    });

    expect(result.ok).toBe(true);
    expect(queries.getTicketByTicketId(db, ticketId)?.assigneeAgentId).toBeNull();
    expect(queries.getDashboardEventsByRepo(db, repoId).map((event) => event.eventType)).toEqual([
      "ticket_created",
      "ticket_assigned",
      "ticket_unassigned",
    ]);
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
    expect(knowledgeRefreshArgs).toHaveLength(1);
    expect(knowledgeRefreshArgs[0]).toHaveLength(1);

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

  it("stores the provided commit SHA when resolving a ticket", async () => {
    const createResult = await createTicketRecord(ctx, {
      title: "Backfill commit metadata",
      description: "Resolution should carry the landing commit instead of the creation HEAD.",
      severity: "medium",
      priority: 3,
      tags: ["audit"],
      affectedPaths: ["src/tickets/service.ts"],
      acceptanceCriteria: "Resolved ticket points at landing commit",
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const ticketId = createResult.data.ticketId as string;
    const ticket = queries.getTicketByTicketId(db, ticketId)!;
    queries.updateTicket(db, ticket.id, { status: "ready_for_commit", commitSha: "stale000" });

    const result = updateTicketStatusRecord(ctx, {
      ticketId,
      status: "resolved",
      comment: "Resolved after merge.",
      commitSha: "def5678",
    });

    expect(result.ok).toBe(true);
    expect(queries.getTicketByTicketId(db, ticketId)?.commitSha).toBe("def5678");
    expect(queries.getTicketResolutionCommitShas(db, ticket.id)).toEqual(["def5678"]);
  });

  it("prefers referenced child ticket commits over fallback HEAD when resolving umbrella tickets", () => {
    const childOne = queries.insertTicket(db, {
      repoId,
      ticketId: "TKT-child001",
      title: "Child one",
      description: "Implements the first slice.",
      status: "resolved",
      severity: "medium",
      priority: 4,
      creatorAgentId: "agent-dev",
      creatorSessionId: "session-dev",
      resolvedByAgentId: "system:service",
      commitSha: "child111",
      createdAt: "2026-03-12T01:00:00.000Z",
      updatedAt: "2026-03-12T01:10:00.000Z",
    });
    const childTwo = queries.insertTicket(db, {
      repoId,
      ticketId: "TKT-child002",
      title: "Child two",
      description: "Implements the second slice.",
      status: "resolved",
      severity: "medium",
      priority: 4,
      creatorAgentId: "agent-dev",
      creatorSessionId: "session-dev",
      resolvedByAgentId: "system:service",
      commitSha: "child222",
      createdAt: "2026-03-12T01:20:00.000Z",
      updatedAt: "2026-03-12T01:30:00.000Z",
    });
    queries.setTicketResolutionCommitShas(db, childOne.id, ["child111"]);
    queries.setTicketResolutionCommitShas(db, childTwo.id, ["child222"]);

    const parent = queries.insertTicket(db, {
      repoId,
      ticketId: "TKT-parent001",
      title: "Umbrella delivery",
      description: "Roll up the child tickets into one delivered milestone.",
      status: "ready_for_commit",
      severity: "high",
      priority: 7,
      creatorAgentId: "agent-dev",
      creatorSessionId: "session-dev",
      commitSha: "stale000",
      createdAt: "2026-03-12T02:00:00.000Z",
      updatedAt: "2026-03-12T02:05:00.000Z",
    });

    const result = updateTicketStatusRecord(ctx, {
      ticketId: parent.ticketId,
      status: "resolved",
      comment: "Umbrella complete after TKT-child001 and TKT-child002 landed.",
      commitSha: "head999",
    });

    expect(result.ok).toBe(true);
    expect(queries.getTicketByTicketId(db, parent.ticketId)?.commitSha).toBe("child111");
    expect(queries.getTicketResolutionCommitShas(db, parent.id)).toEqual(["child111", "child222", "head999"]);
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

  it("blocks entering in_progress without an assignee from system context", async () => {
    const createResult = await createTicketRecord(ctx, {
      title: "Ownerless work item",
      description: "System transitions should not invent implementation ownership.",
      severity: "medium",
      priority: 6,
      tags: ["workflow"],
      affectedPaths: [],
      acceptanceCriteria: null,
    });
    expect(createResult.ok).toBe(true);
    const ticketId = createResult.ok ? String(createResult.data.ticketId) : "";

    expect(updateTicketStatusRecord(ctx, {
      ticketId,
      status: "technical_analysis",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId,
      status: "approved",
    }).ok).toBe(true);

    const result = updateTicketStatusRecord(ctx, {
      ticketId,
      status: "in_progress",
      autoAssign: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe("invalid_request");
    expect(result.message).toContain("Cannot move to in_progress without an assignee");
    expect(result.data).toMatchObject({
      assigneeAgentId: null,
      autoAssignAllowed: false,
      transition: "approved→in_progress",
    });
    expect(queries.getTicketByTicketId(db, ticketId)?.status).toBe("approved");
    expect(queries.getTicketByTicketId(db, ticketId)?.assigneeAgentId).toBeNull();
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

  it("batch resolves tickets with a single deferred knowledge refresh", async () => {
    const first = await createTicketRecord(ctx, {
      title: "First knowledge batch ticket",
      description: "Batch resolution target A",
      severity: "medium",
      priority: 8,
      tags: ["knowledge"],
      affectedPaths: ["src/tickets/service.ts"],
      acceptanceCriteria: null,
    });
    const second = await createTicketRecord(ctx, {
      title: "Second knowledge batch ticket",
      description: "Batch resolution target B",
      severity: "medium",
      priority: 8,
      tags: ["knowledge"],
      affectedPaths: ["src/search/fts5.ts"],
      acceptanceCriteria: null,
    });
    const firstTicketId = first.ok ? String(first.data.ticketId) : "";
    const secondTicketId = second.ok ? String(second.data.ticketId) : "";

    expect(updateTicketStatusRecord(ctx, {
      ticketId: firstTicketId,
      status: "technical_analysis",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: secondTicketId,
      status: "technical_analysis",
    }).ok).toBe(true);

    knowledgeRefreshCount = 0;
    knowledgeRefreshArgs = [];

    const result = batchTransitionTickets(ctx, {
      actorLabel: "batch-resolver",
      ticketIds: [firstTicketId, secondTicketId],
      toStatus: "resolved",
      comment: "Bulk resolution capture",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.ok).toBe(true);
    expect(knowledgeRefreshCount).toBe(1);
    expect(knowledgeRefreshArgs).toEqual([undefined]);
    expect(queries.getKnowledgeByKey(db, `solution:ticket:${firstTicketId.toLowerCase()}`)).toBeTruthy();
    expect(queries.getKnowledgeByKey(db, `solution:ticket:${secondTicketId.toLowerCase()}`)).toBeTruthy();

    const results = knowledgeFts.searchKnowledge(sqlite, "Bulk resolution capture", 10);
    expect(results).toHaveLength(2);
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
      status: "technical_analysis",
      comment: "Invalidate stale approval and return to council",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reviewReadyTicketId,
      status: "approved",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reviewReadyTicketId,
      status: "blocked",
      comment: "Waiting on release dependency before pickup",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reviewReadyTicketId,
      status: "approved",
      comment: "Dependency cleared, return to ready queue",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reviewReadyTicketId,
      status: "in_review",
      comment: "Change already landed, review directly",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reviewReadyTicketId,
      status: "blocked",
      comment: "External sign-off pending",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reviewReadyTicketId,
      status: "in_review",
      comment: "Sign-off arrived, resume review",
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
      status: "approved",
      comment: "Administrative requeue after false positive start",
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
      status: "blocked",
      comment: "Release window paused",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(ctx, {
      ticketId: reopenedTicketId,
      status: "ready_for_commit",
      comment: "Release window reopened",
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

  it("clears active verdicts when a ticket re-enters technical_analysis", async () => {
    const { ticketId, ticket } = await createTechnicalAnalysisTicket();

    for (const specialization of ["architect", "simplifier", "performance", "patterns"] as const) {
      recordVerdict(db, ticket.id, {
        specialization,
        verdict: "pass",
      });
    }

    expect(updateTicketStatusRecord(reviewerCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    }).ok).toBe(true);
    expect(queries.getActiveReviewVerdicts(db, ticket.id)).toHaveLength(4);

    expect(updateTicketStatusRecord(systemCtx, {
      ticketId,
      status: "backlog",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(systemCtx, {
      ticketId,
      status: "technical_analysis",
    }).ok).toBe(true);

    expect(queries.getActiveReviewVerdicts(db, ticket.id)).toHaveLength(0);
    expect(queries.getVerdictHistory(db, ticket.id).every((row) => row.supersededBy === queries.REVIEW_VERDICT_CLEARED_ON_RESET)).toBe(true);

    const blocked = updateTicketStatusRecord(reviewerCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.ok ? "" : blocked.message).toContain("Council quorum not met");
  });

  it("clears active verdicts when a ticket enters in_review", async () => {
    registerActor(db, { agentId: "agent-dev", sessionId: "session-dev", roleId: "developer" });
    const devCtx: TicketServiceContext = {
      ...reviewerCtx,
    };
    const { ticketId, ticket } = await createTechnicalAnalysisTicket();

    for (const specialization of ["architect", "simplifier", "performance", "patterns"] as const) {
      recordVerdict(db, ticket.id, {
        specialization,
        verdict: "pass",
      });
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
    expect(updateTicketStatusRecord(devCtx, {
      ticketId,
      status: "in_progress",
      agentId: "agent-dev",
      sessionId: "session-dev",
    }).ok).toBe(true);

    expect(queries.getActiveReviewVerdicts(db, ticket.id)).toHaveLength(4);
    expect(updateTicketStatusRecord(devCtx, {
      ticketId,
      status: "in_review",
      agentId: "agent-dev",
      sessionId: "session-dev",
    }).ok).toBe(true);

    expect(queries.getActiveReviewVerdicts(db, ticket.id)).toHaveLength(0);
    expect(queries.getVerdictHistory(db, ticket.id).every((row) => row.supersededBy === queries.REVIEW_VERDICT_CLEARED_ON_RESET)).toBe(true);
  });

  it("can auto-assign a non-system actor when entering in_progress", async () => {
    registerActor(db, { agentId: "agent-dev", sessionId: "session-dev", roleId: "developer" });
    const devCtx: TicketServiceContext = {
      ...reviewerCtx,
    };
    const { ticketId, ticket } = await createTechnicalAnalysisTicket();

    for (const specialization of ["architect", "simplifier", "performance", "patterns"] as const) {
      recordVerdict(db, ticket.id, {
        specialization,
        verdict: "pass",
      });
    }

    expect(updateTicketStatusRecord(reviewerCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    }).ok).toBe(true);

    const result = updateTicketStatusRecord(devCtx, {
      ticketId,
      status: "in_progress",
      autoAssign: true,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.ok).toBe(true);
    expect(result.ok ? result.data.assigneeAgentId : null).toBe("agent-dev");
    expect(queries.getTicketByTicketId(db, ticketId)?.status).toBe("in_progress");
    expect(queries.getTicketByTicketId(db, ticketId)?.assigneeAgentId).toBe("agent-dev");
    expect(queries.getDashboardEventsByRepo(db, repoId).map((event) => event.eventType)).toContain("ticket_assigned");
  });

  it("blocks entering in_progress without an assignee when autoAssign is not requested", async () => {
    registerActor(db, { agentId: "agent-dev", sessionId: "session-dev", roleId: "developer" });
    const devCtx: TicketServiceContext = {
      ...reviewerCtx,
    };
    const { ticketId, ticket } = await createTechnicalAnalysisTicket();

    for (const specialization of ["architect", "simplifier", "performance", "patterns"] as const) {
      recordVerdict(db, ticket.id, {
        specialization,
        verdict: "pass",
      });
    }

    expect(updateTicketStatusRecord(reviewerCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    }).ok).toBe(true);

    const result = updateTicketStatusRecord(devCtx, {
      ticketId,
      status: "in_progress",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe("invalid_request");
    expect(result.message).toContain("Cannot move to in_progress without an assignee");
    expect(result.data).toMatchObject({
      assigneeAgentId: null,
      autoAssignAllowed: true,
      transition: "approved→in_progress",
    });
    expect(queries.getTicketByTicketId(db, ticketId)?.status).toBe("approved");
    expect(queries.getTicketByTicketId(db, ticketId)?.assigneeAgentId).toBeNull();
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
        enabled: true,
        requiredPasses: 2,
        vetoSpecializations: ["security"],
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
    // Reviewer (non-admin) should be blocked by quorum with no verdicts
    expect(updateTicketStatusRecord(reviewerCtx, {
      ticketId,
      status: "approved",
      agentId: "agent-review",
      sessionId: "session-review",
    }).ok).toBe(false);

    const ticket = queries.getTicketByTicketId(db, ticketId)!;
    recordVerdict(db, ticket.id, { specialization: "architect", verdict: "pass" });

    // Admin bypasses quorum — use systemCtx for setup transitions
    expect(updateTicketStatusRecord(systemCtx, {
      ticketId,
      status: "approved",
    }).ok).toBe(true);
    expect(updateTicketStatusRecord(systemCtx, {
      ticketId,
      status: "in_review",
    }).ok).toBe(true);

    recordVerdict(db, ticket.id, { specialization: "architect", verdict: "pass" });
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

    const verdictSpy = vi.spyOn(queries, "getActiveReviewVerdicts");
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
        modelDiversity: { strict: false, maxVotersPerModel: 3 },
        reviewerIndependence: { strict: true, identityKey: "agent" },
        backlogPlanningGate: { enforce: true, minIterations: 3, requiredDistinctModels: 2 },
        requireBinding: false,
        autoAdvance: true,
        autoAdvanceExcludedTags: [],
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

describe("ticket service governance: backlog planning gate", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let repoId: number;
  let governanceCtx: TicketServiceContext;
  let reviewerCtx: TicketServiceContext;
  let systemCtx: TicketSystemContext;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;

    registerActor(db, { agentId: "agent-review", sessionId: "session-review", roleId: "reviewer" });
    registerActor(db, { agentId: "agent-review-2", sessionId: "session-review-2", roleId: "reviewer" });

    const now = new Date().toISOString();
    queries.upsertAgent(db, {
      ...(queries.getAgent(db, "agent-review") ?? {
        id: "agent-review",
        name: "agent-review",
        type: "test",
        roleId: "reviewer",
        trustTier: "A",
        registeredAt: now,
      }),
      provider: "openai",
      model: "gpt-5",
    });
    queries.upsertAgent(db, {
      ...(queries.getAgent(db, "agent-review-2") ?? {
        id: "agent-review-2",
        name: "agent-review-2",
        type: "test",
        roleId: "reviewer",
        trustTier: "A",
        registeredAt: now,
      }),
      provider: "anthropic",
      model: "sonnet",
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
        modelDiversity: { strict: true, maxVotersPerModel: 3 },
        reviewerIndependence: { strict: true, identityKey: "agent" },
        backlogPlanningGate: { enforce: true, minIterations: 3, requiredDistinctModels: 2 },
        requireBinding: false,
        autoAdvance: true,
        autoAdvanceExcludedTags: [],
      },
    };
    systemCtx = {
      ...reviewerCtx,
      system: true,
      actorLabel: "cli admin",
    };
  });

  afterEach(() => sqlite.close());

  async function createBacklogTicket() {
    const created = await createTicketRecord(systemCtx, {
      title: "Planning gate",
      description: "Needs structured backlog planning before TA",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      acceptanceCriteria: null,
    });
    expect(created.ok).toBe(true);
    return created.ok ? String(created.data.ticketId) : "";
  }

  async function addPlanComment(ticketId: string, actor: { agentId: string; sessionId: string }, content: string) {
    const result = commentTicketRecord(reviewerCtx, {
      ticketId,
      content,
      agentId: actor.agentId,
      sessionId: actor.sessionId,
    });
    expect(result.ok).toBe(true);
  }

  it("blocks backlog to technical_analysis when there are fewer than three structured plan iterations", async () => {
    const ticketId = await createBacklogTicket();

    await addPlanComment(ticketId, { agentId: "agent-review", sessionId: "session-review" }, "[Technical Analysis]\nSummary\nDraft one");
    await addPlanComment(ticketId, { agentId: "agent-review-2", sessionId: "session-review-2" }, "[Plan Review]\nConcern\nDraft two");

    const result = updateTicketStatusRecord(governanceCtx, {
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("2/3 structured plan iterations");
      expect(result.data?.distinctModels).toBe(2);
    }
  });

  it("blocks backlog to technical_analysis when plan iterations do not span two distinct models", async () => {
    const ticketId = await createBacklogTicket();

    queries.upsertAgent(db, {
      ...(queries.getAgent(db, "agent-review-2") ?? {
        id: "agent-review-2",
        name: "agent-review-2",
        type: "test",
        roleId: "reviewer",
        trustTier: "A",
        registeredAt: new Date().toISOString(),
      }),
      provider: "openai",
      model: "gpt-5",
    });

    await addPlanComment(ticketId, { agentId: "agent-review", sessionId: "session-review" }, "[Technical Analysis]\nSummary\nDraft one");
    await addPlanComment(ticketId, { agentId: "agent-review-2", sessionId: "session-review-2" }, "[Plan Iteration]\nRevision\nDraft two");
    await addPlanComment(ticketId, { agentId: "agent-review", sessionId: "session-review" }, "[Plan Review]\nFeedback\nDraft three");

    const result = updateTicketStatusRecord(governanceCtx, {
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("1/2 distinct models");
      expect(result.data?.iterationCount).toBe(3);
    }
  });

  it("allows backlog to technical_analysis after three structured iterations across two models", async () => {
    const ticketId = await createBacklogTicket();

    await addPlanComment(ticketId, { agentId: "agent-review", sessionId: "session-review" }, "[Technical Analysis]\nSummary\nDraft one");
    await addPlanComment(ticketId, { agentId: "agent-review-2", sessionId: "session-review-2" }, "[Plan Review]\nConcerns\nDraft two");
    await addPlanComment(ticketId, { agentId: "agent-review", sessionId: "session-review" }, "[Plan Iteration]\nRevision\nDraft three");

    const result = updateTicketStatusRecord(governanceCtx, {
      ticketId,
      status: "technical_analysis",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    expect(result.ok).toBe(true);
  });
});

describe("ticket service governance: resolution guards", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let repoId: number;
  let ctx: TicketServiceContext;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    registerActor(db, { agentId: "agent-dev", sessionId: "session-dev", roleId: "developer" });
    registerActor(db, { agentId: "agent-dev-2", sessionId: "session-dev-2", roleId: "developer" });
    registerActor(db, { agentId: "agent-admin", sessionId: "session-admin", roleId: "admin" });
    ctx = {
      db,
      repoId,
      repoPath: "/test",
      insight: { info: () => undefined, warn: () => undefined },
    };
  });

  afterEach(() => sqlite.close());

  async function createAndAssignTicket(
    assigneeAgentId: string,
    statuses: readonly ("technical_analysis" | "approved" | "in_progress" | "in_review" | "ready_for_commit")[] = [
      "technical_analysis",
      "approved",
      "in_progress",
      "in_review",
      "ready_for_commit",
    ],
  ) {
    const result = await createTicketRecord(
      { ...ctx, system: true, actorLabel: "test" },
      { title: "T", description: "D", severity: "medium", priority: 5, tags: [], affectedPaths: [] },
    );
    const ticketId = result.ok ? String(result.data.ticketId) : "";
    assignTicketRecord(ctx, {
      ticketId,
      assigneeAgentId,
      agentId: assigneeAgentId,
      sessionId: assigneeAgentId === "agent-dev" ? "session-dev" : assigneeAgentId === "agent-admin" ? "session-admin" : "session-dev-2",
    });
    // Move through lifecycle to ready_for_commit
    for (const status of statuses) {
      updateTicketStatusRecord(
        { ...ctx, system: true, actorLabel: "test" },
        { ticketId, status, actorLabel: "test" },
      );
    }
    return ticketId;
  }

  it("allows assignee to resolve their own ticket", async () => {
    const ticketId = await createAndAssignTicket("agent-dev");
    commentTicketRecord(ctx, {
      ticketId,
      content: "Verified: works as expected",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    const result = updateTicketStatusRecord(ctx, {
      ticketId,
      status: "resolved",
      comment: "Done",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    expect(result.ok).toBe(true);
  });

  it("denies non-assignee developer from resolving", async () => {
    const ticketId = await createAndAssignTicket("agent-dev");
    const result = updateTicketStatusRecord(ctx, {
      ticketId,
      status: "resolved",
      comment: "Done",
      agentId: "agent-dev-2",
      sessionId: "session-dev-2",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("assigned to themselves");
  });

  it("allows facilitator/admin to resolve with justification comment", async () => {
    const ticketId = await createAndAssignTicket("agent-dev");
    commentTicketRecord(ctx, {
      ticketId,
      content: "Verified: works as expected",
      agentId: "agent-admin",
      sessionId: "session-admin",
    });
    const result = updateTicketStatusRecord(ctx, {
      ticketId,
      status: "resolved",
      comment: "Resolving on behalf of dev — verified implementation",
      agentId: "agent-admin",
      sessionId: "session-admin",
    });
    expect(result.ok).toBe(true);
  });

  it("denies facilitator/admin resolving without justification comment", async () => {
    const ticketId = await createAndAssignTicket("agent-dev");
    commentTicketRecord(ctx, {
      ticketId,
      content: "Verified",
      agentId: "agent-admin",
      sessionId: "session-admin",
    });
    const result = updateTicketStatusRecord(ctx, {
      ticketId,
      status: "resolved",
      agentId: "agent-admin",
      sessionId: "session-admin",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("justification comment");
  });

  it("requires at least one ticket comment before resolving from ready_for_commit", async () => {
    const ticketId = await createAndAssignTicket("agent-dev");
    // No comments added — try to resolve
    const result = updateTicketStatusRecord(ctx, {
      ticketId,
      status: "resolved",
      comment: "Done",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Verification evidence not met");
  });

  it("rejects planning comments created before ready_for_commit as resolution evidence", async () => {
    const ticketId = await createAndAssignTicket("agent-dev", [
      "technical_analysis",
      "approved",
      "in_progress",
      "in_review",
    ]);
    commentTicketRecord(ctx, {
      ticketId,
      content: "[Plan Review] implementation looks ready",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    updateTicketStatusRecord(
      { ...ctx, system: true, actorLabel: "test" },
      { ticketId, status: "ready_for_commit", actorLabel: "test" },
    );

    const result = updateTicketStatusRecord(ctx, {
      ticketId,
      status: "resolved",
      comment: "Done",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Verification evidence not met");
  });

  it("rejects non-verification comments created after ready_for_commit", async () => {
    const ticketId = await createAndAssignTicket("agent-dev");
    commentTicketRecord(ctx, {
      ticketId,
      content: "Please verify tool output and docs.",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const result = updateTicketStatusRecord(ctx, {
      ticketId,
      status: "resolved",
      comment: "Done",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Verification evidence not met");
  });

  it("allows system actors to resolve without assignee check or comment", async () => {
    const ticketId = await createAndAssignTicket("agent-dev");
    const result = updateTicketStatusRecord(
      { ...ctx, system: true, actorLabel: "post-commit" },
      { ticketId, status: "resolved", actorLabel: "post-commit" },
    );
    expect(result.ok).toBe(true);
  });

  it("emits rate-limit warning when agent resolves >3 tickets in 1 hour", async () => {
    const warnings: string[] = [];
    const warnCtx: TicketServiceContext = {
      ...ctx,
      insight: { info: () => undefined, warn: (msg: string) => warnings.push(msg) },
    };

    for (let i = 0; i < 4; i++) {
      const ticketId = await createAndAssignTicket("agent-dev");
      commentTicketRecord(warnCtx, {
        ticketId,
        content: "Verified",
        agentId: "agent-dev",
        sessionId: "session-dev",
      });
      updateTicketStatusRecord(warnCtx, {
        ticketId,
        status: "resolved",
        comment: `Resolved ticket ${i + 1}`,
        agentId: "agent-dev",
        sessionId: "session-dev",
      });
    }

    expect(warnings.some((w) => w.includes("Audit notice"))).toBe(true);
  });

  it("emits shared commit SHA warning when resolving with a SHA used by another ticket", async () => {
    const warnings: string[] = [];
    const warnCtx: TicketServiceContext = {
      ...ctx,
      insight: { info: () => undefined, warn: (msg: string) => warnings.push(msg) },
    };

    // Resolve first ticket — sets commitSha to "abc1234"
    const ticketId1 = await createAndAssignTicket("agent-dev");
    commentTicketRecord(warnCtx, { ticketId: ticketId1, content: "Verified", agentId: "agent-dev", sessionId: "session-dev" });
    updateTicketStatusRecord(warnCtx, {
      ticketId: ticketId1,
      status: "resolved",
      comment: "Done",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    // Resolve second ticket — same commitSha "abc1234"
    const ticketId2 = await createAndAssignTicket("agent-dev");
    commentTicketRecord(warnCtx, { ticketId: ticketId2, content: "Verified", agentId: "agent-dev", sessionId: "session-dev" });
    const result = updateTicketStatusRecord(warnCtx, {
      ticketId: ticketId2,
      status: "resolved",
      comment: "Done",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sharedCommitWarning).toContain("abc1234");
    expect(result.data.sharedCommitWarning).toContain(ticketId1);
    expect(warnings.some((w) => w.includes("abc1234"))).toBe(true);
  });

  it("does not emit shared commit warning for unique SHA", async () => {
    const warnings: string[] = [];
    const warnCtx: TicketServiceContext = {
      ...ctx,
      insight: { info: () => undefined, warn: (msg: string) => warnings.push(msg) },
    };

    const ticketId = await createAndAssignTicket("agent-dev");
    commentTicketRecord(warnCtx, { ticketId, content: "Verified", agentId: "agent-dev", sessionId: "session-dev" });
    const result = updateTicketStatusRecord(warnCtx, {
      ticketId,
      status: "resolved",
      comment: "Done",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sharedCommitWarning).toBeUndefined();
    expect(warnings.some((w) => w.includes("already associated"))).toBe(false);
  });

  it("ignores non-resolved tickets when checking for shared commit SHA warnings", async () => {
    const warnings: string[] = [];
    const warnCtx: TicketServiceContext = {
      ...ctx,
      insight: { info: () => undefined, warn: (msg: string) => warnings.push(msg) },
    };

    await createAndAssignTicket("agent-dev");

    const ticketId = await createAndAssignTicket("agent-dev");
    commentTicketRecord(warnCtx, {
      ticketId,
      content: "Verified: landed and checked",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    const result = updateTicketStatusRecord(warnCtx, {
      ticketId,
      status: "resolved",
      comment: "Done",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sharedCommitWarning).toBeUndefined();
    expect(warnings.some((w) => w.includes("already associated"))).toBe(false);
  });
});

describe("duplicate / twin ticket detection", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let repoId: number;
  let bus: CoordinationBus;
  let ctx: TicketSystemContext;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    bus = new CoordinationBus("hub-spoke", 200, db, repoId);

    ctx = {
      db,
      repoId,
      repoPath: "/test",
      system: true,
      actorLabel: "cli admin",
      insight: { info: () => undefined, warn: () => undefined },
      bus,
      refreshTicketSearch: () => {},
      refreshKnowledgeSearch: () => {},
    };
  });

  afterEach(() => {
    sqlite.close();
  });

  it("returns warnings when creating a ticket with similar title to existing open ticket", async () => {
    // Create an existing ticket
    const first = await createTicketRecord(ctx, {
      title: "Add user authentication to API",
      description: "desc",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      actorLabel: "test",
    });
    expect(first.ok).toBe(true);

    // Create a similar ticket
    const second = await createTicketRecord(ctx, {
      title: "Add user authentication to API system",
      description: "desc",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      actorLabel: "test",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.warnings).toBeDefined();
    expect(Array.isArray(second.data.warnings)).toBe(true);
    expect((second.data.warnings as string[]).some((w: string) => w.includes("Possible duplicate"))).toBe(true);
  });

  it("returns no warnings when creating a ticket with a unique title", async () => {
    await createTicketRecord(ctx, {
      title: "Add user authentication to API",
      description: "desc",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      actorLabel: "test",
    });

    const result = await createTicketRecord(ctx, {
      title: "Fix database connection pooling issue",
      description: "desc",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      actorLabel: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.warnings).toBeUndefined();
  });

  it("does NOT flag similar title on closed/wont_fix tickets", async () => {
    const first = await createTicketRecord(ctx, {
      title: "Add user authentication to API",
      description: "desc",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      actorLabel: "test",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Move ticket to wont_fix (simplest terminal path: backlog → wont_fix)
    const ticketId = first.data.ticketId as string;
    const wontFix = updateTicketStatusRecord(ctx, { ticketId, status: "wont_fix", actorLabel: "test" });
    expect(wontFix.ok).toBe(true);

    // Now create a similar ticket — should NOT warn since original is wont_fix
    const second = await createTicketRecord(ctx, {
      title: "Add user authentication to API system",
      description: "desc",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      actorLabel: "test",
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Should not have duplicate warnings (may have batch warning)
    const dupWarning = (second.data.warnings as string[] | undefined)?.find((w: string) => w.includes("Possible duplicate"));
    expect(dupWarning).toBeUndefined();
  });

  it("triggers batch creation warning when 3+ tickets created by same agent in 5 minutes", async () => {
    // Create 3 tickets rapidly
    for (let i = 0; i < 3; i++) {
      await createTicketRecord(ctx, {
        title: `Unique ticket number ${i} with distinct words ${i}`,
        description: "desc",
        severity: "medium",
        priority: 5,
        tags: [],
        affectedPaths: [],
        actorLabel: "test",
      });
    }

    // 4th ticket should trigger batch warning
    const result = await createTicketRecord(ctx, {
      title: "Yet another completely different ticket for testing batch",
      description: "desc",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      actorLabel: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.warnings).toBeDefined();
    expect((result.data.warnings as string[]).some((w: string) => w.includes("Batch creation notice"))).toBe(true);
  });

  it("titleSimilarity returns high score for similar titles (tested via duplicate detection)", async () => {
    // Create first ticket
    await createTicketRecord(ctx, {
      title: "Implement caching layer for database queries",
      description: "desc",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      actorLabel: "test",
    });

    // Create ticket with nearly identical title
    const result = await createTicketRecord(ctx, {
      title: "Implement caching layer for database queries optimization",
      description: "desc",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      actorLabel: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.warnings).toBeDefined();
    const dupWarning = (result.data.warnings as string[]).find((w: string) => w.includes("Possible duplicate"));
    expect(dupWarning).toBeDefined();
    // Should show high similarity percentage
    expect(dupWarning).toMatch(/\d+% similar/);
  });

  it("titleSimilarity returns low score for different titles (no warning)", async () => {
    await createTicketRecord(ctx, {
      title: "Implement caching layer for database queries",
      description: "desc",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      actorLabel: "test",
    });

    const result = await createTicketRecord(ctx, {
      title: "Fix broken authentication middleware in production",
      description: "desc",
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      actorLabel: "test",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No duplicate warning (may have batch warning if 3+ tickets)
    const dupWarning = (result.data.warnings as string[] | undefined)?.find((w: string) => w.includes("Possible duplicate"));
    expect(dupWarning).toBeUndefined();
  });
});
