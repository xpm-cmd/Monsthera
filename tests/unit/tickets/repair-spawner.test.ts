import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { spawnRepairTicket, type RepairBlockerSource, type RepairSpawnerConfig } from "../../../src/tickets/repair-spawner.js";
import type { TicketSystemContext } from "../../../src/tickets/service.js";

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

// Mock git operations to avoid real filesystem calls
vi.mock("../../../src/git/operations.js", () => ({
  getHead: async () => "abc123",
}));

describe("repair-spawner", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let repoId: number;
  const now = new Date().toISOString();

  function makeCtx(): TicketSystemContext {
    return {
      db,
      repoId,
      repoPath: "/test",
      insight: { info: () => {}, warn: () => {} },
      system: true,
      actorLabel: "test",
    };
  }

  const enabledConfig: RepairSpawnerConfig = {
    enabled: true,
    allowedSources: ["council_veto", "lifecycle_suppression"],
  };

  function insertParentTicket(ticketId = "TKT-parent01"): number {
    const ticket = db.insert(schema.tickets).values({
      repoId,
      ticketId,
      title: "Parent ticket",
      description: "Test parent",
      status: "in_review",
      severity: "high",
      priority: 8,
      tagsJson: "[]",
      affectedPathsJson: JSON.stringify(["src/foo.ts"]),
      creatorAgentId: "system",
      creatorSessionId: "system",
      commitSha: "abc123",
      createdAt: now,
      updatedAt: now,
    }).returning().get();
    return ticket.id;
  }

  function makeSource(overrides: Partial<RepairBlockerSource> = {}): RepairBlockerSource {
    return {
      type: "council_veto",
      parentTicketId: "TKT-parent01",
      parentTicketTitle: "Parent ticket",
      reason: "architect: insufficient error handling",
      sourceSpecializations: ["architect"],
      affectedPaths: ["src/foo.ts"],
      severity: "high",
      ...overrides,
    };
  }

  beforeEach(() => {
    ({ db } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
  });

  it("returns config_disabled when spawner is disabled", async () => {
    insertParentTicket();
    const result = await spawnRepairTicket(makeCtx(), makeSource(), { enabled: false, allowedSources: [] });
    expect(result).toEqual({ spawned: false, reason: "config_disabled" });
  });

  it("returns source_not_allowed when source type is not in allowedSources", async () => {
    insertParentTicket();
    const result = await spawnRepairTicket(
      makeCtx(),
      makeSource({ type: "lifecycle_suppression" }),
      { enabled: true, allowedSources: ["council_veto"] },
    );
    expect(result).toEqual({ spawned: false, reason: "source_not_allowed" });
  });

  it("returns parent_not_found when parent ticket does not exist", async () => {
    const result = await spawnRepairTicket(makeCtx(), makeSource(), enabledConfig);
    expect(result).toEqual({ spawned: false, reason: "parent_not_found" });
  });

  it("spawns a repair ticket on council veto", async () => {
    insertParentTicket();
    const result = await spawnRepairTicket(makeCtx(), makeSource(), enabledConfig);

    expect(result.spawned).toBe(true);
    expect(result.reason).toBe("created");
    expect(result.ticketId).toMatch(/^TKT-/);

    // Verify repair ticket exists in DB
    const repair = queries.getTicketByTicketId(db, result.ticketId!, repoId);
    expect(repair).toBeTruthy();
    expect(repair!.title).toContain("Repair:");
    expect(repair!.title).toContain("architect");
    expect(repair!.severity).toBe("high");

    const tags = JSON.parse(repair!.tagsJson ?? "[]");
    expect(tags).toContain("repair:council_veto");
    expect(tags).toContain("parent:TKT-parent01");
  });

  it("links repair ticket to parent and adds audit comment", async () => {
    const parentInternalId = insertParentTicket();
    const result = await spawnRepairTicket(makeCtx(), makeSource(), enabledConfig);

    // Check link
    const deps = queries.getTicketDependencies(db, parentInternalId);
    expect(deps.outgoing).toHaveLength(1);
    expect(deps.outgoing[0]!.relationType).toBe("relates_to");

    // Check audit comment on parent
    const comments = db.select().from(schema.ticketComments).all()
      .filter((c) => c.ticketId === parentInternalId && c.content.includes("[Auto-Repair]"));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.content).toContain(result.ticketId);
  });

  it("deduplicates — skips if an open repair ticket of same type already exists", async () => {
    insertParentTicket();

    // First spawn
    const first = await spawnRepairTicket(makeCtx(), makeSource(), enabledConfig);
    expect(first.spawned).toBe(true);

    // Second spawn — should dedupe
    const second = await spawnRepairTicket(makeCtx(), makeSource(), enabledConfig);
    expect(second).toEqual({ spawned: false, reason: "dedupe_skipped" });
  });

  it("spawns again after previous repair ticket is resolved", async () => {
    insertParentTicket();

    const first = await spawnRepairTicket(makeCtx(), makeSource(), enabledConfig);
    expect(first.spawned).toBe(true);

    // Resolve the repair ticket
    const repairTicket = queries.getTicketByTicketId(db, first.ticketId!, repoId);
    queries.updateTicket(db, repairTicket!.id, { status: "resolved" });

    // Now a new spawn should succeed
    const second = await spawnRepairTicket(makeCtx(), makeSource(), enabledConfig);
    expect(second.spawned).toBe(true);
    expect(second.ticketId).not.toBe(first.ticketId);
  });

  it("emits a dashboard event on spawn", async () => {
    insertParentTicket();
    await spawnRepairTicket(makeCtx(), makeSource(), enabledConfig);

    const events = db.select().from(schema.dashboardEvents).all();
    const repairEvent = events.find((e) => e.eventType === "ticket_repair_spawned");
    expect(repairEvent).toBeTruthy();
    const data = JSON.parse(repairEvent!.dataJson);
    expect(data.parentTicketId).toBe("TKT-parent01");
    expect(data.source).toBe("council_veto");
  });
});
