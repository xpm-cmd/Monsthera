import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { TicketLifecycleReactor } from "../../../src/tickets/lifecycle.js";

vi.mock("../../../src/git/operations.js", () => ({
  getHead: async () => "abc123",
}));

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
    CREATE TABLE coordination_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), message_id TEXT NOT NULL UNIQUE, from_agent_id TEXT NOT NULL, to_agent_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE dashboard_events (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), event_type TEXT NOT NULL, data_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    CREATE TABLE ticket_dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, from_ticket_id INTEGER NOT NULL REFERENCES tickets(id), to_ticket_id INTEGER NOT NULL REFERENCES tickets(id), relation_type TEXT NOT NULL, created_by_agent_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE council_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, specialization TEXT NOT NULL, assigned_by_agent_id TEXT NOT NULL, assigned_at TEXT NOT NULL);
    CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT, status TEXT NOT NULL DEFAULT 'active', agent_id TEXT, session_id TEXT, embedding BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE VIRTUAL TABLE knowledge_fts USING fts5(knowledge_id UNINDEXED, title, content, type UNINDEXED, tags);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("TicketLifecycleReactor integration", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;
  let repoId: number;
  const now = new Date().toISOString();

  function insertTicket(input: {
    ticketId: string;
    title: string;
    status: string;
    severity?: string;
    priority?: number;
    tags?: string[];
    affectedPaths?: string[];
  }): number {
    const ticket = db.insert(schema.tickets).values({
      repoId,
      ticketId: input.ticketId,
      title: input.title,
      description: `${input.title} description`,
      status: input.status,
      severity: input.severity ?? "high",
      priority: input.priority ?? 8,
      tagsJson: JSON.stringify(input.tags ?? []),
      affectedPathsJson: JSON.stringify(input.affectedPaths ?? ["src/foo.ts"]),
      creatorAgentId: "system",
      creatorSessionId: "system",
      commitSha: "abc123",
      createdAt: now,
      updatedAt: now,
    }).returning().get();
    return ticket.id;
  }

  function createReactor() {
    return new TicketLifecycleReactor({
      config: {
        repoPath: "/test",
        lifecycle: {
          enabled: true,
          autoTriageOnCreate: true,
          autoTriageSeverityThreshold: "medium",
          autoTriagePriorityThreshold: 5,
          autoCloseResolvedAfterMs: 0,
          autoReviewOnPatch: false,
          autoCascadeBlocked: true,
          sweepIntervalMs: 60_000,
        },
        repairSpawner: {
          enabled: true,
          allowedSources: ["council_veto", "lifecycle_suppression"],
        },
      } as any,
      db,
      sqlite,
      repoId,
      repoPath: "/test",
      insight: {
        info: vi.fn(),
        warn: vi.fn(),
      } as any,
      searchRouter: {
        rebuildTicketFts: vi.fn(),
        rebuildKnowledgeFts: vi.fn(),
        upsertKnowledgeFts: vi.fn(),
      } as any,
      bus: {
        send: vi.fn(),
      } as any,
    });
  }

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
  });

  afterEach(() => {
    sqlite.close();
  });

  it("spawns a lifecycle suppression repair ticket when auto-unblock is suppressed by provenance", async () => {
    const blockerId = insertTicket({
      ticketId: "TKT-blocker",
      title: "Resolved blocker",
      status: "resolved",
    });
    const blockedId = insertTicket({
      ticketId: "TKT-blocked",
      title: "Blocked parent",
      status: "blocked",
      affectedPaths: ["src/blocked.ts"],
    });

    db.insert(schema.ticketDependencies).values({
      fromTicketId: blockerId,
      toTicketId: blockedId,
      relationType: "blocks",
      createdByAgentId: "agent-dev",
      createdAt: now,
    }).run();
    db.insert(schema.ticketHistory).values({
      ticketId: blockedId,
      fromStatus: "in_progress",
      toStatus: "blocked",
      agentId: "agent-dev",
      sessionId: "session-dev",
      comment: "Manually blocked on dependency",
      timestamp: now,
    }).run();

    const reactor = createReactor();
    reactor.sweep();
    await Promise.resolve();
    await Promise.resolve();

    const repairTicket = queries.getTicketsByRepo(db, repoId).find((ticket) =>
      JSON.parse(ticket.tagsJson ?? "[]").includes("repair:lifecycle_suppression"),
    );
    expect(repairTicket).toBeTruthy();
    expect(JSON.parse(repairTicket!.tagsJson ?? "[]")).toEqual(
      expect.arrayContaining(["repair:lifecycle_suppression", "parent:TKT-blocked"]),
    );

    const parentComments = db.select().from(schema.ticketComments).all()
      .filter((comment) => comment.ticketId === blockedId);
    expect(parentComments.at(-1)?.content).toContain("[Auto-Repair]");
    expect(parentComments.at(-1)?.content).toContain("lifecycle_suppression");
  });

  it("comments on the parent and emits an event when a repair ticket reaches a terminal state", () => {
    insertTicket({
      ticketId: "TKT-parent",
      title: "Parent ticket",
      status: "blocked",
    });
    insertTicket({
      ticketId: "TKT-repair",
      title: "Repair ticket",
      status: "resolved",
      tags: ["repair:lifecycle_suppression", "parent:TKT-parent"],
    });

    const reactor = createReactor();
    reactor.onTicketStatusChanged({
      ticketId: "TKT-repair",
      previousStatus: "in_progress",
      status: "resolved",
      actorLabel: "agent-dev",
    });

    const parent = queries.getTicketByTicketId(db, "TKT-parent", repoId);
    const comments = db.select().from(schema.ticketComments).all()
      .filter((comment) => comment.ticketId === parent!.id);
    expect(comments.at(-1)?.content).toContain("Follow-up TKT-repair reached resolved");
    expect(comments.at(-1)?.content).toContain("Re-run the suppressed lifecycle path");

    const events = db.select().from(schema.dashboardEvents).all();
    const event = events.find((entry) => entry.eventType === "ticket_repair_resolved");
    expect(event).toBeTruthy();
    expect(JSON.parse(event!.dataJson)).toMatchObject({
      parentTicketId: "TKT-parent",
      repairTicketId: "TKT-repair",
      status: "resolved",
      source: "lifecycle_suppression",
    });
  });

  it("requeues orphaned in_progress tickets and clears their stale assignee during sweep", () => {
    db.insert(schema.agents).values({
      id: "agent-stale",
      name: "Stale Dev",
      type: "codex",
      roleId: "developer",
      trustTier: "A",
      registeredAt: now,
    }).run();
    db.insert(schema.sessions).values({
      id: "session-stale",
      agentId: "agent-stale",
      state: "active",
      connectedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      lastActivity: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
      claimedFilesJson: JSON.stringify(["src/stale.ts"]),
    }).run();

    const ticketId = insertTicket({
      ticketId: "TKT-orphaned-progress",
      title: "Orphaned in progress",
      status: "in_progress",
    });
    queries.updateTicket(db, ticketId, { assigneeAgentId: "agent-stale" });

    const reactor = createReactor();
    reactor.sweep();

    const ticket = queries.getTicketByTicketId(db, "TKT-orphaned-progress", repoId);
    expect(ticket?.status).toBe("approved");
    expect(ticket?.assigneeAgentId).toBeNull();

    const history = db.select().from(schema.ticketHistory).all()
      .filter((entry) => entry.ticketId === ticketId);
    expect(history.some((entry) => entry.fromStatus === "in_progress" && entry.toStatus === "approved")).toBe(true);

    const comments = db.select().from(schema.ticketComments).all()
      .filter((entry) => entry.ticketId === ticketId);
    expect(comments.at(-1)?.content).toContain("cleared stale assignee");

    const repairEvent = db.select().from(schema.dashboardEvents).all()
      .find((entry) => entry.eventType === "ticket_orphaned_owner_repaired");
    expect(repairEvent).toBeTruthy();
    expect(JSON.parse(repairEvent!.dataJson)).toMatchObject({
      ticketId: "TKT-orphaned-progress",
      previousStatus: "in_progress",
      repairedStatus: "approved",
      previousAssigneeAgentId: "agent-stale",
    });
  });
});
