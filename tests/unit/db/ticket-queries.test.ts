import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', provider TEXT, model TEXT, model_family TEXT, model_version TEXT, identity_source TEXT, role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT, worktree_path TEXT, worktree_branch TEXT);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, resolution_commits_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), from_status TEXT, to_status TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, comment TEXT, timestamp TEXT NOT NULL);
    CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE review_verdicts (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, specialization TEXT NOT NULL, verdict TEXT NOT NULL, reasoning TEXT, created_at TEXT NOT NULL, superseded_by INTEGER);
    CREATE TABLE council_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, specialization TEXT NOT NULL, assigned_by_agent_id TEXT NOT NULL, assigned_at TEXT NOT NULL, UNIQUE(ticket_id, specialization));
    CREATE TABLE ticket_dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, from_ticket_id INTEGER NOT NULL REFERENCES tickets(id), to_ticket_id INTEGER NOT NULL REFERENCES tickets(id), relation_type TEXT NOT NULL, created_by_agent_id TEXT NOT NULL, created_at TEXT NOT NULL);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("ticket queries", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;
  let repoId: number;
  const now = new Date().toISOString();

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    sqlite = result.sqlite;
    repoId = queries.upsertRepo(db, "/test", "test").id;
  });
  afterEach(() => sqlite.close());

  function makeTicket(overrides: Partial<Parameters<typeof queries.insertTicket>[1]> = {}) {
    return queries.insertTicket(db, {
      repoId, ticketId: `TKT-${Math.random().toString(36).slice(2, 10)}`,
      title: "Bug", description: "Desc", status: "backlog", severity: "medium",
      priority: 5, creatorAgentId: "a1", creatorSessionId: "s1", commitSha: "abc123",
      createdAt: now, updatedAt: now, ...overrides,
    });
  }

  it("inserts and retrieves a ticket by ticketId", () => {
    const t = makeTicket({ ticketId: "TKT-test001" });
    expect(t.id).toBeGreaterThan(0);
    const found = queries.getTicketByTicketId(db, "TKT-test001");
    expect(found?.title).toBe("Bug");
  });

  it("can scope ticket lookup by repo when repoId is provided", () => {
    const otherRepoId = queries.upsertRepo(db, "/other", "other").id;
    makeTicket({ ticketId: "TKT-local001" });
    queries.insertTicket(db, {
      repoId: otherRepoId,
      ticketId: "TKT-other001",
      title: "Other repo",
      description: "Desc",
      status: "backlog",
      severity: "medium",
      priority: 5,
      creatorAgentId: "a1",
      creatorSessionId: "s1",
      commitSha: "abc123",
      createdAt: now,
      updatedAt: now,
    });

    expect(queries.getTicketByTicketId(db, "TKT-other001", repoId)).toBeUndefined();
    expect(queries.getTicketByTicketId(db, "TKT-other001", otherRepoId)?.title).toBe("Other repo");
  });

  it("retrieves ticket by internal id", () => {
    const t = makeTicket();
    expect(queries.getTicketById(db, t.id)?.ticketId).toBe(t.ticketId);
  });

  it("updates ticket fields", () => {
    const t = makeTicket();
    queries.updateTicket(db, t.id, { title: "Fixed", severity: "critical", commitSha: "def456" });
    const updated = queries.getTicketById(db, t.id)!;
    expect(updated.title).toBe("Fixed");
    expect(updated.severity).toBe("critical");
    expect(updated.commitSha).toBe("def456");
  });

  it("stores normalized resolution commit lists when the column is available", () => {
    const t = makeTicket();
    const updatedAt = "2026-03-12T03:00:00.000Z";

    expect(queries.setTicketResolutionCommitShas(db, t.id, ["abc1234", "def5678", "abc1234"], updatedAt)).toBe(true);
    expect(queries.getTicketResolutionCommitShas(db, t.id)).toEqual(["abc1234", "def5678"]);
    expect(queries.getTicketById(db, t.id)?.updatedAt).toBe(updatedAt);

    expect(queries.setTicketResolutionCommitShas(db, t.id, [], "2026-03-12T04:00:00.000Z")).toBe(true);
    expect(queries.getTicketResolutionCommitShas(db, t.id)).toEqual([]);
  });

  it("filters tickets by status", () => {
    makeTicket({ status: "backlog" });
    makeTicket({ status: "in_progress" });
    const backlog = queries.getTicketsByRepo(db, repoId, { status: "backlog" });
    expect(backlog).toHaveLength(1);
  });

  it("filters tickets by assignee", () => {
    makeTicket({ assigneeAgentId: "dev-1" });
    makeTicket({ assigneeAgentId: "dev-2" });
    const result = queries.getTicketsByRepo(db, repoId, { assigneeAgentId: "dev-1" });
    expect(result).toHaveLength(1);
  });

  it("counts tickets by status", () => {
    makeTicket({ status: "backlog" });
    makeTicket({ status: "backlog" });
    makeTicket({ status: "resolved" });
    const counts = queries.getTicketCountsByStatus(db, repoId);
    expect(counts.backlog).toBe(2);
    expect(counts.resolved).toBe(1);
  });

  it("counts open tickets (excludes resolved/closed/wont_fix)", () => {
    makeTicket({ status: "backlog" });
    makeTicket({ status: "in_progress" });
    makeTicket({ status: "resolved" });
    makeTicket({ status: "closed" });
    expect(queries.getOpenTicketCount(db, repoId)).toBe(2);
  });

  it("counts total tickets", () => {
    makeTicket();
    makeTicket();
    makeTicket();
    expect(queries.getTotalTicketCount(db, repoId)).toBe(3);
  });

  it("inserts and retrieves ticket history", () => {
    const t = makeTicket();
    queries.insertTicketHistory(db, {
      ticketId: t.id, fromStatus: null, toStatus: "backlog",
      agentId: "a1", sessionId: "s1", comment: "Created", timestamp: now,
    });
    queries.insertTicketHistory(db, {
      ticketId: t.id, fromStatus: "backlog", toStatus: "technical_analysis",
      agentId: "a1", sessionId: "s1", timestamp: now,
    });
    const history = queries.getTicketHistory(db, t.id);
    expect(history).toHaveLength(2);
    expect(history[0]!.toStatus).toBe("backlog");
    expect(history[1]!.fromStatus).toBe("backlog");
  });

  it("orders ticket history chronologically across mixed timestamp formats", () => {
    const t = makeTicket();
    queries.insertTicketHistory(db, {
      ticketId: t.id, fromStatus: null, toStatus: "backlog",
      agentId: "a1", sessionId: "s1", comment: "Created", timestamp: "2026-03-10 09:25:20",
    });
    queries.insertTicketHistory(db, {
      ticketId: t.id, fromStatus: "backlog", toStatus: "technical_analysis",
      agentId: "a2", sessionId: "s2", comment: "TA", timestamp: "2026-03-10T09:50:06.000Z",
    });
    queries.insertTicketHistory(db, {
      ticketId: t.id, fromStatus: "technical_analysis", toStatus: "approved",
      agentId: "a3", sessionId: "s3", comment: "Approved", timestamp: "2026-03-10 11:15:58",
    });

    const history = queries.getTicketHistory(db, t.id);
    expect(history.map((entry) => entry.toStatus)).toEqual(["backlog", "technical_analysis", "approved"]);
  });

  it("inserts and retrieves ticket comments", () => {
    const t = makeTicket();
    queries.insertTicketComment(db, {
      ticketId: t.id, agentId: "a1", sessionId: "s1", content: "Hello", createdAt: now,
    });
    const comments = queries.getTicketComments(db, t.id);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.content).toBe("Hello");
  });

  it("orders ticket comments chronologically across mixed timestamp formats", () => {
    const t = makeTicket();
    queries.insertTicketComment(db, {
      ticketId: t.id, agentId: "a1", sessionId: "s1", content: "first", createdAt: "2026-03-10 09:25:20",
    });
    queries.insertTicketComment(db, {
      ticketId: t.id, agentId: "a2", sessionId: "s2", content: "second", createdAt: "2026-03-10T09:50:06.000Z",
    });
    queries.insertTicketComment(db, {
      ticketId: t.id, agentId: "a3", sessionId: "s3", content: "third", createdAt: "2026-03-10 11:15:58",
    });

    const comments = queries.getTicketComments(db, t.id);
    expect(comments.map((comment) => comment.content)).toEqual(["first", "second", "third"]);
  });

  it("preserves verdict history while exposing only the active specialization verdict", () => {
    const t = makeTicket();
    const first = queries.insertReviewVerdict(db, {
      ticketId: t.id,
      agentId: "architect-1",
      sessionId: "session-1",
      specialization: "architect",
      verdict: "pass",
      reasoning: "Initial review",
      createdAt: "2026-03-10T09:25:20.000Z",
    });
    const second = queries.insertReviewVerdict(db, {
      ticketId: t.id,
      agentId: "architect-2",
      sessionId: "session-2",
      specialization: "architect",
      verdict: "fail",
      reasoning: "Updated review",
      createdAt: "2026-03-10T10:25:20.000Z",
    });

    const verdicts = queries.getActiveReviewVerdicts(db, t.id);
    const history = queries.getVerdictHistory(db, t.id, "architect");
    expect(first.id).not.toBe(second.id);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({
      specialization: "architect",
      verdict: "fail",
      agentId: "architect-2",
      reasoning: "Updated review",
    });
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      id: first.id,
      verdict: "pass",
      supersededBy: second.id,
    });
    expect(history[1]).toMatchObject({
      id: second.id,
      verdict: "fail",
      supersededBy: null,
    });
  });

  it("upserts council assignments with latest specialization owner", () => {
    const t = makeTicket();
    const first = queries.upsertCouncilAssignment(db, {
      ticketId: t.id,
      agentId: "agent-a",
      specialization: "architect",
      assignedByAgentId: "facilitator-1",
      assignedAt: "2026-03-10T09:25:20.000Z",
    });
    const second = queries.upsertCouncilAssignment(db, {
      ticketId: t.id,
      agentId: "agent-b",
      specialization: "architect",
      assignedByAgentId: "facilitator-2",
      assignedAt: "2026-03-10T10:25:20.000Z",
    });

    expect(second.id).toBe(first.id);
    expect(queries.getCouncilAssignment(db, t.id, "agent-a", "architect")).toBeUndefined();
    expect(queries.getCouncilAssignment(db, t.id, "agent-b", "architect")).toMatchObject({
      ticketId: t.id,
      agentId: "agent-b",
      specialization: "architect",
      assignedByAgentId: "facilitator-2",
    });
    expect(queries.getCouncilAssignmentsForTicket(db, t.id)).toHaveLength(1);
  });

  it("links patch to ticket and retrieves by ticket", () => {
    const t = makeTicket();
    const p = queries.insertPatch(db, {
      repoId, proposalId: "P-001", baseCommit: "abc", state: "proposed",
      diff: "---", message: "fix", agentId: "a1", sessionId: "s1",
      createdAt: now, updatedAt: now,
    });
    queries.linkPatchToTicket(db, p.id, t.id);
    const linked = queries.getPatchesByTicketId(db, t.id);
    expect(linked).toHaveLength(1);
    expect(linked[0]!.proposalId).toBe("P-001");
  });

  it("filters by severity", () => {
    makeTicket({ severity: "critical" });
    makeTicket({ severity: "low" });
    const critical = queries.getTicketsByRepo(db, repoId, { severity: "critical" });
    expect(critical).toHaveLength(1);
    expect(critical[0]!.severity).toBe("critical");
  });

  it("filters by creator", () => {
    makeTicket({ creatorAgentId: "reviewer-1" });
    makeTicket({ creatorAgentId: "reviewer-2" });
    const result = queries.getTicketsByRepo(db, repoId, { creatorAgentId: "reviewer-1" });
    expect(result).toHaveLength(1);
  });

  it("filters by tags with AND logic", () => {
    makeTicket({ ticketId: "TKT-a", tagsJson: JSON.stringify(["bug", "ui"]) });
    makeTicket({ ticketId: "TKT-b", tagsJson: JSON.stringify(["bug"]) });
    makeTicket({ ticketId: "TKT-c", tagsJson: JSON.stringify(["ui", "backend"]) });

    const result = queries.getTicketsByRepo(db, repoId, { tags: ["bug", "ui"] });

    expect(result).toHaveLength(1);
    expect(result[0]!.ticketId).toBe("TKT-a");
  });

  it("applies limit after tag filtering", () => {
    makeTicket({ ticketId: "TKT-other-1", priority: 10, tagsJson: JSON.stringify(["other"]) });
    makeTicket({ ticketId: "TKT-other-2", priority: 9, tagsJson: JSON.stringify(["other"]) });
    makeTicket({ ticketId: "TKT-bug-1", priority: 8, tagsJson: JSON.stringify(["bug"]) });
    makeTicket({ ticketId: "TKT-bug-2", priority: 7, tagsJson: JSON.stringify(["bug"]) });

    const result = queries.getTicketsByRepo(db, repoId, { tags: ["bug"], limit: 2 });

    expect(result).toHaveLength(2);
    expect(result.map((ticket) => ticket.ticketId)).toEqual(["TKT-bug-1", "TKT-bug-2"]);
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) makeTicket();
    const result = queries.getTicketsByRepo(db, repoId, { limit: 3 });
    expect(result).toHaveLength(3);
  });

  // --- Ticket Dependencies ---

  it("creates and retrieves a blocks dependency", () => {
    const a = makeTicket({ ticketId: "TKT-a" });
    const b = makeTicket({ ticketId: "TKT-b" });
    queries.createTicketDependency(db, {
      fromTicketId: a.id, toTicketId: b.id,
      relationType: "blocks", createdByAgentId: "a1", createdAt: now,
    });
    const deps = queries.getTicketDependencies(db, a.id);
    expect(deps.outgoing).toHaveLength(1);
    expect(deps.outgoing[0]!.toTicketId).toBe(b.id);
    expect(deps.incoming).toHaveLength(0);

    const depsB = queries.getTicketDependencies(db, b.id);
    expect(depsB.incoming).toHaveLength(1);
    expect(depsB.incoming[0]!.fromTicketId).toBe(a.id);
    expect(depsB.outgoing).toHaveLength(0);
  });

  it("creates and retrieves a relates_to dependency", () => {
    const a = makeTicket({ ticketId: "TKT-r1" });
    const b = makeTicket({ ticketId: "TKT-r2" });
    queries.createTicketDependency(db, {
      fromTicketId: a.id, toTicketId: b.id,
      relationType: "relates_to", createdByAgentId: "a1", createdAt: now,
    });
    // relates_to is visible from both sides
    const depsA = queries.getTicketDependencies(db, a.id);
    expect(depsA.outgoing).toHaveLength(1);
    const depsB = queries.getTicketDependencies(db, b.id);
    expect(depsB.incoming).toHaveLength(1);
  });

  it("deletes a dependency (including relates_to in reverse)", () => {
    const a = makeTicket({ ticketId: "TKT-d1" });
    const b = makeTicket({ ticketId: "TKT-d2" });
    queries.createTicketDependency(db, {
      fromTicketId: a.id, toTicketId: b.id,
      relationType: "relates_to", createdByAgentId: "a1", createdAt: now,
    });
    // Delete using reverse direction — should still remove relates_to
    queries.deleteTicketDependency(db, b.id, a.id);
    const deps = queries.getTicketDependencies(db, a.id);
    expect(deps.outgoing).toHaveLength(0);
    expect(deps.incoming).toHaveLength(0);
  });

  it("getAllBlocksEdges returns only blocks edges", () => {
    const a = makeTicket({ ticketId: "TKT-e1" });
    const b = makeTicket({ ticketId: "TKT-e2" });
    const c = makeTicket({ ticketId: "TKT-e3" });
    queries.createTicketDependency(db, {
      fromTicketId: a.id, toTicketId: b.id,
      relationType: "blocks", createdByAgentId: "a1", createdAt: now,
    });
    queries.createTicketDependency(db, {
      fromTicketId: a.id, toTicketId: c.id,
      relationType: "relates_to", createdByAgentId: "a1", createdAt: now,
    });
    const edges = queries.getAllBlocksEdges(db);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.fromTicketId).toBe(a.id);
    expect(edges[0]!.toTicketId).toBe(b.id);
  });
});
