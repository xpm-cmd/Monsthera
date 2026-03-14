import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import {
  buildTicketDetailPayload,
  buildTicketListPayload,
  buildTicketSummaryPayload,
} from "../../../src/tickets/read-model.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, resolution_commits_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), from_status TEXT, to_status TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, comment TEXT, timestamp TEXT NOT NULL);
    CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE ticket_dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, from_ticket_id INTEGER NOT NULL REFERENCES tickets(id), to_ticket_id INTEGER NOT NULL REFERENCES tickets(id), relation_type TEXT NOT NULL, created_by_agent_id TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("ticket read model", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let repoId: number;
  let otherRepoId: number;
  const now = "2026-03-12T02:00:00.000Z";

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/repo", "repo").id;
    otherRepoId = queries.upsertRepo(db, "/other", "other").id;
  });

  afterEach(() => sqlite.close());

  function makeTicket(overrides: Partial<Parameters<typeof queries.insertTicket>[1]> = {}) {
    return queries.insertTicket(db, {
      repoId,
      ticketId: `TKT-${Math.random().toString(36).slice(2, 10)}`,
      title: "Ticket",
      description: "Description",
      status: "backlog",
      severity: "medium",
      priority: 5,
      creatorAgentId: "agent-creator",
      creatorSessionId: "session-creator",
      commitSha: "abc1234",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
  }

  it("builds repo-scoped ticket lists with compact fields", () => {
    makeTicket({
      ticketId: "TKT-local001",
      title: "Local in progress",
      status: "in_progress",
      assigneeAgentId: "agent-dev",
      priority: 9,
    });
    queries.insertTicket(db, {
      repoId: otherRepoId,
      ticketId: "TKT-foreign01",
      title: "Foreign in progress",
      description: "Other repo",
      status: "in_progress",
      severity: "high",
      priority: 10,
      creatorAgentId: "agent-other",
      creatorSessionId: "session-other",
      commitSha: "def5678",
      createdAt: now,
      updatedAt: now,
    });

    const payload = buildTicketListPayload(db, repoId, { status: "in_progress" });

    expect(payload).toEqual({
      count: 1,
      tickets: [{
        ticketId: "TKT-local001",
        title: "Local in progress",
        status: "in_progress",
        severity: "medium",
        priority: 9,
        assigneeAgentId: "agent-dev",
        creatorAgentId: "agent-creator",
        updatedAt: now,
      }],
    });
  });

  it("builds full ticket detail payloads with dependencies, comments, history, and linked patches", () => {
    const blocking = makeTicket({ ticketId: "TKT-blocking", title: "Blocking work" });
    const detail = makeTicket({
      ticketId: "TKT-detail001",
      title: "Dispatch advisory rules",
      description: "Implement advisory dispatch suggestions.",
      status: "in_review",
      severity: "high",
      priority: 8,
      tagsJson: JSON.stringify(["dispatch", "tickets"]),
      affectedPathsJson: JSON.stringify(["src/dispatch/rules.ts", "src/tools/read-tools.ts"]),
      acceptanceCriteria: "Tool returns advisory actions and required roles.",
      assigneeAgentId: "agent-dev",
    });
    const related = makeTicket({ ticketId: "TKT-related01", title: "Follow-up docs" });

    queries.insertTicketHistory(db, {
      ticketId: detail.id,
      fromStatus: "approved",
      toStatus: "in_progress",
      agentId: "agent-dev",
      sessionId: "session-dev",
      comment: "Started implementation",
      timestamp: "2026-03-12T02:05:00.000Z",
    });
    queries.insertTicketHistory(db, {
      ticketId: detail.id,
      fromStatus: "in_progress",
      toStatus: "in_review",
      agentId: "agent-dev",
      sessionId: "session-dev",
      comment: "Ready for review",
      timestamp: "2026-03-12T02:25:00.000Z",
    });
    queries.insertTicketComment(db, {
      ticketId: detail.id,
      agentId: "agent-reviewer",
      sessionId: "session-reviewer",
      content: "Please verify tool output and docs.",
      createdAt: "2026-03-12T02:26:00.000Z",
    });
    const patch = queries.insertPatch(db, {
      repoId,
      proposalId: "P-123",
      baseCommit: "abc1234",
      state: "proposed",
      diff: "---",
      message: "Add advisory dispatch CLI",
      agentId: "agent-dev",
      sessionId: "session-dev",
      ticketId: detail.id,
      createdAt: "2026-03-12T02:24:00.000Z",
      updatedAt: "2026-03-12T02:24:00.000Z",
    });
    expect(patch.proposalId).toBe("P-123");
    queries.createTicketDependency(db, {
      fromTicketId: detail.id,
      toTicketId: blocking.id,
      relationType: "blocks",
      createdByAgentId: "agent-dev",
      createdAt: now,
    });
    queries.createTicketDependency(db, {
      fromTicketId: detail.id,
      toTicketId: related.id,
      relationType: "relates_to",
      createdByAgentId: "agent-dev",
      createdAt: now,
    });
    queries.setTicketResolutionCommitShas(db, detail.id, ["ff0011", "ff0022"], now);

    const payload = buildTicketDetailPayload(db, repoId, "TKT-detail001");

    expect(payload).not.toBeNull();
    expect(payload).toMatchObject({
      ticketId: "TKT-detail001",
      title: "Dispatch advisory rules",
      status: "in_review",
      severity: "high",
      priority: 8,
      tags: ["dispatch", "tickets"],
      affectedPaths: ["src/dispatch/rules.ts", "src/tools/read-tools.ts"],
      acceptanceCriteria: "Tool returns advisory actions and required roles.",
      assigneeAgentId: "agent-dev",
      resolutionCommitShas: ["ff0011", "ff0022"],
      dependencies: {
        blocking: ["TKT-blocking"],
        blockedBy: [],
        relatedTo: ["TKT-related01"],
      },
      history: [
        expect.objectContaining({ toStatus: "in_progress" }),
        expect.objectContaining({ toStatus: "in_review" }),
      ],
      comments: [
        expect.objectContaining({ agentId: "agent-reviewer", content: "Please verify tool output and docs." }),
      ],
      linkedPatches: [
        expect.objectContaining({ proposalId: "P-123", message: "Add advisory dispatch CLI" }),
      ],
    });
  });

  it("builds ticket summary payloads for active workflow views", () => {
    makeTicket({ ticketId: "TKT-progress01", title: "In progress", status: "in_progress", severity: "high", priority: 9 });
    makeTicket({ ticketId: "TKT-review01", title: "In review", status: "in_review", severity: "medium", priority: 7 });
    makeTicket({ ticketId: "TKT-blocked01", title: "Blocked", status: "blocked", severity: "critical", priority: 10 });
    makeTicket({ ticketId: "TKT-done001", title: "Resolved", status: "resolved", severity: "low", priority: 3 });

    const summary = buildTicketSummaryPayload(db, repoId);

    expect(summary.totalCount).toBe(4);
    expect(summary.openCount).toBe(3);
    expect(summary.statusCounts).toMatchObject({
      in_progress: 1,
      in_review: 1,
      blocked: 1,
      resolved: 1,
    });
    expect(summary.severityCounts).toMatchObject({
      critical: 1,
      high: 1,
      medium: 1,
      low: 1,
    });
    expect(summary.inProgress[0]?.ticketId).toBe("TKT-progress01");
    expect(summary.inReview[0]?.ticketId).toBe("TKT-review01");
    expect(summary.blocked[0]?.ticketId).toBe("TKT-blocked01");
  });
});
