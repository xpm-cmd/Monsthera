import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { registerTicketTools } from "../../../src/tools/ticket-tools.js";
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

describe("relatedTo soft limit and prune_stale_relations", () => {
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

    for (const agent of [
      { id: "agent-dev", name: "Dev", roleId: "developer", trustTier: "A" },
      { id: "agent-review", name: "Review", roleId: "reviewer", trustTier: "A" },
    ]) {
      queries.upsertAgent(db, {
        id: agent.id,
        name: agent.name,
        type: "test",
        roleId: agent.roleId as "developer" | "reviewer",
        trustTier: agent.trustTier as "A",
        registeredAt: now,
      });
    }

    for (const session of [
      { id: "session-dev", agentId: "agent-dev" },
      { id: "session-review", agentId: "agent-review" },
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

  function createTicket(title: string) {
    return handler("create_ticket")({
      title,
      description: `Description for ${title}`,
      severity: "medium",
      priority: 5,
      tags: [],
      affectedPaths: [],
      agentId: "agent-review",
      sessionId: "session-review",
    });
  }

  async function getTicketId(result: any): Promise<string> {
    return JSON.parse(result.content[0].text).ticketId;
  }

  // ── AC#1: relatedTo soft limit warning ──

  it("emits warning when a ticket exceeds 3 relatedTo edges", async () => {
    const ticketIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await createTicket(`Ticket ${i}`);
      ticketIds.push(await getTicketId(result));
    }

    // Link ticket 0 to tickets 1, 2, 3 (3 relatedTo edges -- no warning)
    for (let i = 1; i <= 3; i++) {
      const result = await handler("link_tickets")({
        fromTicketId: ticketIds[0],
        toTicketId: ticketIds[i],
        relationType: "relates_to",
        agentId: "agent-review",
        sessionId: "session-review",
      });
      const payload = JSON.parse(result.content[0].text);
      expect(payload.warning).toBeUndefined();
    }

    // 4th relatedTo edge triggers warning
    const result = await handler("link_tickets")({
      fromTicketId: ticketIds[0],
      toTicketId: ticketIds[4],
      relationType: "relates_to",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.warning).toBeDefined();
    expect(payload.warning).toContain("4 relatedTo edges");
    expect(payload.warning).toContain("recommended max: 3");
  });

  it("does not emit warning for blocks edges regardless of count", async () => {
    const ticketIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await createTicket(`Block ticket ${i}`);
      ticketIds.push(await getTicketId(result));
    }

    // 4 blocks edges -- no warning (limit applies only to relatedTo)
    for (let i = 1; i <= 4; i++) {
      const result = await handler("link_tickets")({
        fromTicketId: ticketIds[i],
        toTicketId: ticketIds[0],
        relationType: "blocks",
        agentId: "agent-review",
        sessionId: "session-review",
      });
      const payload = JSON.parse(result.content[0].text);
      expect(payload.warning).toBeUndefined();
    }
  });

  // ── AC#3: prune_stale_relations ──

  it("dryRun=true returns count without deleting", async () => {
    const t1Id = await getTicketId(await createTicket("Resolved A"));
    const t2Id = await getTicketId(await createTicket("Resolved B"));

    await handler("link_tickets")({
      fromTicketId: t1Id,
      toTicketId: t2Id,
      relationType: "relates_to",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    // Force resolve + backdate via direct SQL
    const t1 = queries.getTicketByTicketId(db, t1Id)!;
    const t2 = queries.getTicketByTicketId(db, t2Id)!;
    const oldDate = new Date(Date.now() - 10 * 86_400_000).toISOString();
    sqlite.prepare("UPDATE tickets SET status = 'resolved', updated_at = ? WHERE id = ?").run(oldDate, t1.id);
    sqlite.prepare("UPDATE tickets SET status = 'resolved', updated_at = ? WHERE id = ?").run(oldDate, t2.id);

    const result = await handler("prune_stale_relations")({
      dryRun: true,
      olderThanDays: 7,
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.dryRun).toBe(true);
    expect(payload.prunable).toBe(1);
    expect(payload.pruned).toBe(0);
    expect(payload.edges).toHaveLength(1);

    // Edge still exists
    const deps = queries.getTicketDependencies(db, t1.id);
    expect(deps.outgoing).toHaveLength(1);
  });

  it("dryRun=false actually deletes stale edges", async () => {
    const t1Id = await getTicketId(await createTicket("Prune A"));
    const t2Id = await getTicketId(await createTicket("Prune B"));

    await handler("link_tickets")({
      fromTicketId: t1Id,
      toTicketId: t2Id,
      relationType: "relates_to",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    const t1 = queries.getTicketByTicketId(db, t1Id)!;
    const t2 = queries.getTicketByTicketId(db, t2Id)!;
    const oldDate = new Date(Date.now() - 10 * 86_400_000).toISOString();
    sqlite.prepare("UPDATE tickets SET status = 'resolved', updated_at = ? WHERE id = ?").run(oldDate, t1.id);
    sqlite.prepare("UPDATE tickets SET status = 'resolved', updated_at = ? WHERE id = ?").run(oldDate, t2.id);

    const result = await handler("prune_stale_relations")({
      dryRun: false,
      olderThanDays: 7,
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.prunable).toBe(1);
    expect(payload.pruned).toBe(1);

    // Edge deleted
    const deps = queries.getTicketDependencies(db, t1.id);
    expect(deps.outgoing).toHaveLength(0);
  });

  it("prune ignores recently resolved tickets", async () => {
    const t1Id = await getTicketId(await createTicket("Recent A"));
    const t2Id = await getTicketId(await createTicket("Recent B"));

    await handler("link_tickets")({
      fromTicketId: t1Id,
      toTicketId: t2Id,
      relationType: "relates_to",
      agentId: "agent-review",
      sessionId: "session-review",
    });

    // Mark resolved but DON'T backdate (resolved recently)
    const t1 = queries.getTicketByTicketId(db, t1Id)!;
    const t2 = queries.getTicketByTicketId(db, t2Id)!;
    sqlite.prepare("UPDATE tickets SET status = 'resolved' WHERE id = ?").run(t1.id);
    sqlite.prepare("UPDATE tickets SET status = 'resolved' WHERE id = ?").run(t2.id);

    const result = await handler("prune_stale_relations")({
      dryRun: true,
      olderThanDays: 7,
      agentId: "agent-review",
      sessionId: "session-review",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.prunable).toBe(0);
  });
});
