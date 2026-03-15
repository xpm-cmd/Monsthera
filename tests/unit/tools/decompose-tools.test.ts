import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { registerDecomposeTools } from "../../../src/tools/decompose-tools.js";
import { CoordinationBus } from "../../../src/coordination/bus.js";
import { FTS5Backend } from "../../../src/search/fts5.js";

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
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

function makeTask(overrides: Partial<{
  title: string;
  description: string;
  affectedPaths: string[];
  tags: string[];
  severity: string;
  priority: number;
  rationale: string;
  dependsOn: number[];
}> = {}) {
  return {
    title: overrides.title ?? "Default task",
    description: overrides.description ?? "Default description",
    affectedPaths: overrides.affectedPaths ?? [],
    tags: overrides.tags ?? [],
    severity: overrides.severity ?? "medium",
    priority: overrides.priority ?? 5,
    rationale: overrides.rationale ?? "Needed for the goal",
    dependsOn: overrides.dependsOn ?? [],
  };
}

describe("decompose_goal tool", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let repoId: number;
  let bus: CoordinationBus;
  let fts5: FTS5Backend;
  const now = new Date().toISOString();

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    bus = new CoordinationBus("hub-spoke", 200, db, repoId);
    fts5 = new FTS5Backend(sqlite, db);
    fts5.initTicketFts();
    fts5.initKnowledgeFts(sqlite);

    queries.upsertAgent(db, {
      id: "agent-dev",
      name: "Dev",
      type: "test",
      roleId: "developer",
      trustTier: "A",
      registeredAt: now,
    });
    queries.insertSession(db, {
      id: "session-dev",
      agentId: "agent-dev",
      state: "active",
      connectedAt: now,
      lastActivity: now,
    });

    server = new FakeServer();
    registerDecomposeTools(server as unknown as McpServer, async () => ({
      db,
      sqlite,
      config: {},
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

  it("dryRun returns validated decomposition without creating tickets", async () => {
    const result = await handler("decompose_goal")({
      goal: "Add rate limiting",
      proposedTasks: [
        makeTask({ title: "Add rate limiter middleware", affectedPaths: ["src/api/middleware.ts"] }),
        makeTask({ title: "Add rate limit config", affectedPaths: ["src/config.ts"], dependsOn: [] }),
        makeTask({ title: "Wire middleware into router", dependsOn: [0, 1] }),
      ],
      dryRun: true,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.isDryRun).toBe(true);
    expect(payload.proposedTasks).toHaveLength(3);
    expect(payload.dependencyGraph).toHaveLength(2);
    expect(payload.warnings).toHaveLength(0);

    // No tickets created
    const ticketCount = queries.getTotalTicketCount(db, repoId);
    expect(ticketCount).toBe(0);
  });

  it("rejects cyclic dependencies", async () => {
    const result = await handler("decompose_goal")({
      goal: "Circular deps",
      proposedTasks: [
        makeTask({ title: "Task A", dependsOn: [1] }),
        makeTask({ title: "Task B", dependsOn: [0] }),
      ],
      dryRun: true,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toContain("cycles");
  });

  it("rejects out-of-bounds dependency indices", async () => {
    const result = await handler("decompose_goal")({
      goal: "Bad indices",
      proposedTasks: [
        makeTask({ title: "Task A", dependsOn: [5] }),
      ],
      dryRun: true,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.error).toContain("Invalid dependency indices");
  });

  it("truncates with warning when maxTickets exceeded", async () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({ title: `Task ${i}` }),
    );

    const result = await handler("decompose_goal")({
      goal: "Many tasks",
      proposedTasks: tasks,
      maxTickets: 3,
      dryRun: true,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.proposedTasks).toHaveLength(3);
    expect(payload.warnings).toHaveLength(1);
    expect(payload.warnings[0]).toContain("maxTickets");
    expect(payload.warnings[0]).toContain("Truncating");
  });

  it("creates tickets and dependencies when dryRun is false", async () => {
    const result = await handler("decompose_goal")({
      goal: "Build auth system",
      proposedTasks: [
        makeTask({ title: "Create user model", tags: ["auth"] }),
        makeTask({ title: "Add JWT validation", tags: ["auth"], dependsOn: [0] }),
      ],
      dryRun: false,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.isDryRun).toBe(false);
    expect(payload.createdTicketIds).toHaveLength(2);

    // Verify tickets were created
    const ticketCount = queries.getTotalTicketCount(db, repoId);
    expect(ticketCount).toBeGreaterThanOrEqual(2);

    // Verify tickets have "decomposed" tag
    const createdTicket = queries.getTicketByTicketId(db, payload.createdTicketIds[0])!;
    const tags = JSON.parse(createdTicket.tagsJson ?? "[]");
    expect(tags).toContain("decomposed");

    // Verify dependency link was created
    const t1 = queries.getTicketByTicketId(db, payload.createdTicketIds[0])!;
    const deps = queries.getTicketDependencies(db, t1.id);
    expect(deps.outgoing).toHaveLength(1);
  });

  it("each proposed task has title, description, affectedPaths, tags, rationale, dependsOn", async () => {
    const result = await handler("decompose_goal")({
      goal: "Schema check",
      proposedTasks: [
        makeTask({
          title: "Full task",
          description: "A complete description",
          affectedPaths: ["src/foo.ts"],
          tags: ["test"],
          rationale: "Needed for coverage",
          dependsOn: [],
        }),
      ],
      dryRun: true,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    const payload = JSON.parse(result.content[0].text);
    const task = payload.proposedTasks[0];
    expect(task.title).toBe("Full task");
    expect(task.description).toBe("A complete description");
    expect(task.affectedPaths).toEqual(["src/foo.ts"]);
    expect(task.tags).toEqual(["test"]);
    expect(task.rationale).toBe("Needed for coverage");
    expect(task.dependsOn).toEqual([]);
  });
});
