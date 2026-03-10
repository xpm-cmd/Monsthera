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
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), from_status TEXT, to_status TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, comment TEXT, timestamp TEXT NOT NULL);
    CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
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

  it("retrieves ticket by internal id", () => {
    const t = makeTicket();
    expect(queries.getTicketById(db, t.id)?.ticketId).toBe(t.ticketId);
  });

  it("updates ticket fields", () => {
    const t = makeTicket();
    queries.updateTicket(db, t.id, { title: "Fixed", severity: "critical" });
    const updated = queries.getTicketById(db, t.id)!;
    expect(updated.title).toBe("Fixed");
    expect(updated.severity).toBe("critical");
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
      ticketId: t.id, fromStatus: "backlog", toStatus: "assigned",
      agentId: "a1", sessionId: "s1", timestamp: now,
    });
    const history = queries.getTicketHistory(db, t.id);
    expect(history).toHaveLength(2);
    expect(history[0]!.toStatus).toBe("backlog");
    expect(history[1]!.fromStatus).toBe("backlog");
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

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) makeTicket();
    const result = queries.getTicketsByRepo(db, repoId, { limit: 3 });
    expect(result).toHaveLength(3);
  });
});
