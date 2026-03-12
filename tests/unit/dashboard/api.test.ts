import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { CoordinationBus } from "../../../src/coordination/bus.js";
import { getOverview, getAgentsList, getTicketsList, getTicketDetail, getIndexedFilesMetrics, getPresence, getTicketMetrics, getAgentTimeline, getEventLogsList, getDependencyGraph, getKnowledgeGraph, getKnowledgeList, type DashboardDeps } from "../../../src/dashboard/api.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  for (const stmt of [
    `CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE index_state (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, db_indexed_commit TEXT, zoekt_indexed_commit TEXT, indexed_at TEXT, last_success TEXT, last_error TEXT)`,
    `CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, path TEXT NOT NULL, language TEXT, content_hash TEXT, summary TEXT, symbols_json TEXT, has_secrets INTEGER DEFAULT 0, secret_line_ranges TEXT, indexed_at TEXT, commit_sha TEXT, embedding BLOB)`,
    `CREATE TABLE imports (id INTEGER PRIMARY KEY AUTOINCREMENT, source_file_id INTEGER NOT NULL REFERENCES files(id), target_path TEXT NOT NULL, kind TEXT NOT NULL)`,
    `CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', provider TEXT, model TEXT, model_family TEXT, model_version TEXT, identity_source TEXT, role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL)`,
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT)`,
    `CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, from_status TEXT, to_status TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, comment TEXT, timestamp TEXT NOT NULL)`,
    `CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE ticket_dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, from_ticket_id INTEGER NOT NULL, to_ticket_id INTEGER NOT NULL, relation_type TEXT NOT NULL, created_by_agent_id TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL UNIQUE, content TEXT NOT NULL, metadata_json TEXT, linked_paths_json TEXT, agent_id TEXT, session_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT, status TEXT NOT NULL DEFAULT 'active', agent_id TEXT, session_id TEXT, embedding BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE event_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, tool TEXT NOT NULL, timestamp TEXT NOT NULL, duration_ms REAL NOT NULL, status TEXT NOT NULL, repo_id TEXT NOT NULL, commit_scope TEXT NOT NULL, payload_size_in INTEGER NOT NULL, payload_size_out INTEGER NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT NOT NULL, redacted_summary TEXT NOT NULL, error_code TEXT, error_detail TEXT, denial_reason TEXT)`,
  ]) {
    sqlite.prepare(stmt).run();
  }
  const db = drizzle(sqlite, { schema });
  // Insert a repo
  sqlite.prepare(`INSERT INTO repos (path, name, created_at) VALUES (?, ?, ?)`).run("/test", "test", new Date().toISOString());
  return { db, sqlite };
}

describe("Dashboard API", () => {
  let deps: DashboardDeps;
  let sqlite: InstanceType<typeof Database>;

  beforeEach(() => {
    const result = createTestDb();
    sqlite = result.sqlite;
    deps = {
      db: result.db,
      repoId: 1,
      repoPath: "/test",
      bus: new CoordinationBus("hub-spoke"),
      globalDb: null,
    };
  });
  afterEach(() => sqlite.close());

  it("returns overview with correct counts", () => {
    // Add an agent
    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("agent-1", "Dev", "test", "developer", "A", new Date().toISOString());
    sqlite.prepare(`INSERT INTO sessions (id, agent_id, state, connected_at, last_activity) VALUES (?, ?, ?, ?, ?)`)
      .run("s-1", "agent-1", "active", new Date().toISOString(), new Date().toISOString());

    const overview = getOverview(deps);

    expect(overview.totalAgents).toBe(1);
    expect(overview.activeSessions).toBe(1);
    expect(overview.fileCount).toBe(0);
    expect(overview.coordinationTopology).toBe("hub-spoke");
  });

  it("does not count stale active sessions in overview metrics", () => {
    const stale = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("agent-stale", "Stale Dev", "test", "developer", "A", stale);
    sqlite.prepare(`INSERT INTO sessions (id, agent_id, state, connected_at, last_activity) VALUES (?, ?, ?, ?, ?)`)
      .run("s-stale", "agent-stale", "active", stale, stale);

    const overview = getOverview(deps);

    expect(overview.totalAgents).toBe(1);
    expect(overview.activeSessions).toBe(0);
  });

  it("returns agents list with session counts", () => {
    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("agent-1", "Dev", "claude-code", "developer", "A", new Date().toISOString());
    sqlite.prepare(`INSERT INTO sessions (id, agent_id, state, connected_at, last_activity) VALUES (?, ?, ?, ?, ?)`)
      .run("s-1", "agent-1", "active", new Date().toISOString(), new Date().toISOString());
    sqlite.prepare(`INSERT INTO sessions (id, agent_id, state, connected_at, last_activity) VALUES (?, ?, ?, ?, ?)`)
      .run("s-2", "agent-1", "disconnected", new Date().toISOString(), new Date().toISOString());

    const agents = getAgentsList(deps);

    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("Dev");
    expect(agents[0]!.activeSessions).toBe(1); // only active, not disconnected
  });

  it("returns per-agent activity timelines ordered by most recent event", () => {
    const now = Date.now();
    const recent = new Date(now).toISOString();
    const older = new Date(now - 60_000).toISOString();

    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("agent-a", "Agent A", "codex", "developer", "A", older);
    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("agent-b", "Agent B", "claude", "reviewer", "A", older);
    sqlite.prepare(`INSERT INTO sessions (id, agent_id, state, connected_at, last_activity) VALUES (?, ?, ?, ?, ?)`)
      .run("session-a", "agent-a", "active", older, recent);

    const insertEvent = sqlite.prepare(`
      INSERT INTO event_logs (
        event_id, agent_id, session_id, tool, timestamp, duration_ms, status,
        repo_id, commit_scope, payload_size_in, payload_size_out, input_hash,
        output_hash, redacted_summary, error_code, error_detail, denial_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertEvent.run("evt-1", "agent-a", "session-a", "create_ticket", recent, 42, "success", "1", "abc1234", 10, 20, "in1", "out1", "Created ticket", null, null, null);
    insertEvent.run("evt-2", "agent-a", "session-a", "comment_ticket", older, 30, "success", "1", "abc1234", 10, 20, "in2", "out2", "Added context", null, null, null);
    insertEvent.run("evt-3", "agent-b", "session-b", "search_tickets", older, 55, "success", "1", "abc1234", 10, 20, "in3", "out3", "Searched tickets", null, null, null);

    const timeline = getAgentTimeline(deps, 5);

    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({
      agentId: "agent-a",
      activeSessions: 1,
      totalEvents: 2,
    });
    expect(timeline[0]?.events[0]).toMatchObject({
      tool: "create_ticket",
      redactedSummary: "Created ticket",
    });
    expect(timeline[1]).toMatchObject({
      agentId: "agent-b",
      totalEvents: 1,
    });
  });

  it("hides agents from presence when newest activity is older than 30 minutes", () => {
    const now = Date.now();
    const stale = new Date(now - 31 * 60 * 1000).toISOString();
    const recent = new Date(now - 5 * 60 * 1000).toISOString();

    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("agent-stale", "Stale Agent", "codex", "developer", "A", stale);
    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("agent-recent", "Recent Agent", "codex", "reviewer", "A", recent);

    sqlite.prepare(`INSERT INTO sessions (id, agent_id, state, connected_at, last_activity) VALUES (?, ?, ?, ?, ?)`)
      .run("s-stale", "agent-stale", "active", stale, stale);
    sqlite.prepare(`INSERT INTO sessions (id, agent_id, state, connected_at, last_activity) VALUES (?, ?, ?, ?, ?)`)
      .run("s-recent", "agent-recent", "active", recent, recent);

    const presence = getPresence(deps);

    expect(presence).toHaveLength(1);
    expect(presence[0]?.id).toBe("agent-recent");
  });

  it("keeps recently active or recently disconnected agents in presence", () => {
    const now = Date.now();
    const recent = new Date(now - 12 * 60 * 1000).toISOString();

    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("agent-disconnected", "Recent Disconnect", "claude", "reviewer", "A", recent);
    sqlite.prepare(`INSERT INTO sessions (id, agent_id, state, connected_at, last_activity) VALUES (?, ?, ?, ?, ?)`)
      .run("s-disconnected", "agent-disconnected", "disconnected", recent, recent);

    const presence = getPresence(deps);

    expect(presence).toHaveLength(1);
    expect(presence[0]?.id).toBe("agent-disconnected");
    expect(presence[0]?.status).toBe("offline");
  });

  it("returns empty overview for clean repo", () => {
    const overview = getOverview(deps);
    expect(overview.totalAgents).toBe(0);
    expect(overview.totalPatches).toBe(0);
    expect(overview.fileCount).toBe(0);
  });

  it("surfaces error detail in event log payloads", () => {
    sqlite.prepare(`
      INSERT INTO event_logs (
        event_id, agent_id, session_id, tool, timestamp, duration_ms, status,
        repo_id, commit_scope, payload_size_in, payload_size_out, input_hash,
        output_hash, redacted_summary, error_code, error_detail, denial_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("evt-error", "agent-x", "session-x", "store_knowledge", new Date().toISOString(), 18, "error", "1", "abc1234", 12, 30, "in", "out", "store_knowledge: error [sqlite_busy] sqlite busy", "sqlite_busy", "sqlite busy", null);

    const logs = getEventLogsList(deps, 10);

    expect(logs[0]).toMatchObject({
      tool: "store_knowledge",
      status: "error",
      errorCode: "sqlite_busy",
      errorDetail: "sqlite busy",
    });
  });

  it("aggregates indexed file metrics by language and extension fallback", () => {
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, "src/dashboard/html.ts", "typescript", "h1", "summary", "[]", now, "abc1234");
    sqlite.prepare(`
      INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, "src/dashboard/api.ts", "typescript", "h2", "summary", "[]", now, "abc1234");
    sqlite.prepare(`
      INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, "README.md", null, "h3", "summary", "[]", now, "abc1234");
    sqlite.prepare(`
      INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, "Dockerfile", null, "h4", "summary", "[]", now, "abc1234");
    sqlite.prepare(`
      UPDATE files SET has_secrets = 1, secret_line_ranges = ? WHERE path = ?
    `).run(JSON.stringify([{ line: 3, pattern: "github_token" }, { line: 5, pattern: "github_token" }, { line: 7, pattern: "aws_access_key" }]), "src/dashboard/api.ts");

    const files = getIndexedFilesMetrics(deps);

    expect(files.totalFiles).toBe(4);
    expect(files.uniqueBuckets).toBe(3);
    expect(files.topLanguages[0]).toEqual({ label: "typescript", count: 2 });
    expect(files.topLanguages[1]).toEqual({ label: ".md", count: 1 });
    expect(files.unknownFiles).toBe(1);
    expect(files.secretFiles).toBe(1);
    expect(files.topSecretPatterns[0]).toEqual({ label: "github_token", count: 2 });
  });

  it("falls back safely for malformed dashboard JSON payloads", async () => {
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("agent-1", "Dev", "test", "developer", "A", now);
    sqlite.prepare(`INSERT INTO sessions (id, agent_id, state, connected_at, last_activity, claimed_files_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("s-1", "agent-1", "active", now, now, "{bad json");
    sqlite.prepare(`
      INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, secret_line_ranges, indexed_at, commit_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, "src/dashboard/api.ts", "typescript", "h1", "summary", "[]", "{bad json", now, "abc1234");
    sqlite.prepare(`
      INSERT INTO tickets (
        repo_id, ticket_id, title, description, status, severity, priority,
        tags_json, affected_paths_json, creator_agent_id, creator_session_id,
        commit_sha, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, "TKT-1", "Broken JSON", "Desc", "backlog", "medium", 5, "{bad json", "{bad json", "agent-1", "s-1", "abc1234", now, now);
    sqlite.prepare(`
      INSERT INTO knowledge (
        key, type, scope, title, content, tags_json, status, agent_id, session_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("pattern:1", "pattern", "repo", "Pattern", "Content", "{bad json", "active", "agent-1", "s-1", now, now);

    expect(getPresence(deps)[0]?.sessions[0]?.claimedFiles).toEqual([]);
    expect(getIndexedFilesMetrics(deps).topSecretPatterns).toEqual([]);
    expect(getTicketDetail(deps, "TKT-1")?.tags).toEqual([]);
    expect(getTicketDetail(deps, "TKT-1")?.affectedPaths).toEqual([]);
    await expect(getKnowledgeList(deps)).resolves.toMatchObject([
      expect.objectContaining({ tags: [] }),
    ]);
  });

  it("filters knowledge listing by explicit scope without a query", async () => {
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO knowledge (
        key, type, scope, title, content, tags_json, status, agent_id, session_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("pattern:repo", "pattern", "repo", "Repo Pattern", "Repo content", JSON.stringify(["repo"]), "active", "agent-1", "s-1", now, now);

    const globalResult = createTestDb();
    try {
      globalResult.sqlite.prepare(`
        INSERT INTO knowledge (
          key, type, scope, title, content, tags_json, status, agent_id, session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("decision:global", "decision", "global", "Global Decision", "Global content", JSON.stringify(["global"]), "active", "agent-2", "s-2", now, now);

      const scopedDeps = {
        ...deps,
        globalDb: globalResult.db,
      };

      await expect(getKnowledgeList(scopedDeps, { scope: "repo" })).resolves.toMatchObject([
        expect.objectContaining({ key: "pattern:repo", scope: "repo" }),
      ]);
      await expect(getKnowledgeList(scopedDeps, { scope: "global" })).resolves.toMatchObject([
        expect.objectContaining({ key: "decision:global", scope: "global" }),
      ]);
      await expect(getKnowledgeList(scopedDeps, { scope: "all" })).resolves.toHaveLength(2);
    } finally {
      globalResult.sqlite.close();
    }
  });

  it("delegates queried knowledge search to the shared backend provider", async () => {
    const knowledgeSearch = vi.fn().mockResolvedValue([
      {
        key: "pattern:shared",
        type: "pattern",
        scope: "global",
        title: "Shared Auth Guard",
        content: "Shared search result content",
        tags: ["auth", "shared"],
        status: "active",
        agentId: "agent-1",
        updatedAt: "2026-03-11T12:00:00.000Z",
        score: 0.9123,
      },
    ]);

    const results = await getKnowledgeList({
      ...deps,
      knowledgeSearch,
    }, {
      query: "shared auth",
      scope: "global",
      limit: 5,
    });

    expect(knowledgeSearch).toHaveBeenCalledWith({
      query: "shared auth",
      scope: "global",
      type: undefined,
      limit: 5,
    });
    expect(results).toEqual([
      expect.objectContaining({
        key: "pattern:shared",
        scope: "global",
        score: 0.912,
      }),
    ]);
  });

  it("returns all tickets for the dashboard, not just the first 50", () => {
    const stmt = sqlite.prepare(`
      INSERT INTO tickets (
        repo_id, ticket_id, title, description, status, severity, priority,
        creator_agent_id, creator_session_id, commit_sha, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();

    for (let i = 0; i < 60; i++) {
      stmt.run(1, `TKT-${i}`, `Ticket ${i}`, "Desc", "backlog", "medium", 5, "agent-1", "s-1", "abc1234", now, now);
    }

    expect(getTicketsList(deps)).toHaveLength(60);
  });

  it("adds board visibility metadata for high priority and stale in-review tickets", () => {
    const now = Date.now();
    const insertTicket = sqlite.prepare(`
      INSERT INTO tickets (
        repo_id, ticket_id, title, description, status, severity, priority,
        creator_agent_id, creator_session_id, assignee_agent_id, commit_sha, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertTicket.run(1, "TKT-stale-review", "Stale review", "Desc", "in_review", "high", 8, "agent-1", "s-1", null, "abc1234", new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(), new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString());
    insertTicket.run(1, "TKT-active-review", "Active review", "Desc", "in_review", "medium", 5, "agent-1", "s-1", "agent-dev", "abc1234", new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString(), new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString());

    const staleId = Number(sqlite.prepare(`SELECT id FROM tickets WHERE ticket_id = ?`).pluck().get("TKT-stale-review"));
    const activeId = Number(sqlite.prepare(`SELECT id FROM tickets WHERE ticket_id = ?`).pluck().get("TKT-active-review"));

    sqlite.prepare(`
      INSERT INTO ticket_history (ticket_id, from_status, to_status, agent_id, session_id, comment, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(staleId, "in_progress", "in_review", "reviewer-1", "session-1", "Ready for review", new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString());
    sqlite.prepare(`
      INSERT INTO ticket_history (ticket_id, from_status, to_status, agent_id, session_id, comment, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(activeId, "in_progress", "in_review", "reviewer-2", "session-2", "Needs feedback", new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString());
    sqlite.prepare(`
      INSERT INTO ticket_comments (ticket_id, agent_id, session_id, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(activeId, "reviewer-2", "session-2", "Follow-up review note", new Date(now - 12 * 60 * 60 * 1000).toISOString());

    const tickets = getTicketsList(deps);
    const stale = tickets.find((ticket) => ticket.ticketId === "TKT-stale-review");
    const active = tickets.find((ticket) => ticket.ticketId === "TKT-active-review");

    expect(stale).toMatchObject({
      isHighPriority: true,
      inReviewStale: true,
      inReviewIdleDays: 5,
      statusAgeDays: 5,
      assignee: null,
      ageDays: 10,
    });
    expect(active).toMatchObject({
      isHighPriority: false,
      inReviewStale: false,
      inReviewIdleHours: 12,
      statusAgeDays: 2,
      assignee: "agent-dev",
      ageDays: 4,
    });
    expect(active?.lastReviewActivityAt).toBe(new Date(now - 12 * 60 * 60 * 1000).toISOString());
  });

  it("returns scoped ticket metrics for status, severity, aging, blocked, and assignee load", () => {
    const now = Date.now();
    const insert = sqlite.prepare(`
      INSERT INTO tickets (
        repo_id, ticket_id, title, description, status, severity, priority,
        creator_agent_id, creator_session_id, assignee_agent_id, commit_sha, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run(1, "TKT-new", "Fresh backlog", "Desc", "backlog", "medium", 5, "agent-1", "s-1", null, "abc1234", new Date(now - 6 * 60 * 60 * 1000).toISOString(), new Date(now).toISOString());
    insert.run(1, "TKT-aging", "Old in progress", "Desc", "in_progress", "high", 7, "agent-1", "s-1", "agent-dev", "abc1234", new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString(), new Date(now).toISOString());
    insert.run(1, "TKT-blocked", "Blocked item", "Desc", "blocked", "critical", 9, "agent-1", "s-1", "agent-dev", "abc1234", new Date(now - 16 * 24 * 60 * 60 * 1000).toISOString(), new Date(now).toISOString());
    insert.run(1, "TKT-done", "Done item", "Desc", "resolved", "low", 3, "agent-1", "s-1", "agent-dev", "abc1234", new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), new Date(now).toISOString());

    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("agent-dev", "Dev", "codex", "developer", "A", new Date(now).toISOString());

    const metrics = getTicketMetrics(deps);

    expect(metrics.statusCounts).toMatchObject({
      backlog: 1,
      in_progress: 1,
      blocked: 1,
      resolved: 1,
    });
    expect(metrics.severityCounts).toMatchObject({
      medium: 1,
      high: 1,
      critical: 1,
      low: 1,
    });
    expect(metrics.agingBuckets).toMatchObject({
      under1d: 1,
      oneTo3d: 0,
      threeTo7d: 1,
      sevenTo14d: 0,
      over14d: 1,
    });
    expect(metrics.blockedCount).toBe(1);
    expect(metrics.unassignedOpenCount).toBe(1);
    expect(metrics.blockedTickets[0]).toMatchObject({ ticketId: "TKT-blocked" });
    expect(metrics.unassignedOpen[0]).toMatchObject({ ticketId: "TKT-new" });
    expect(metrics.assigneeLoad[0]).toMatchObject({ assigneeAgentId: "agent-dev", count: 2, label: "Dev" });
    expect(metrics.oldestOpen[0]).toMatchObject({ ticketId: "TKT-blocked" });
  });

  it("returns ticket detail with comments, history, and linked patches", () => {
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("reviewer-1", "Claude Review", "claude", "reviewer", "A", now);
    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("reviewer-2", "Codex Review", "codex", "reviewer", "A", now);
    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("reviewer-3", "Mixed Review", "claude", "reviewer", "A", now);
    sqlite.prepare(`
      INSERT INTO tickets (
        id, repo_id, ticket_id, title, description, status, severity, priority,
        tags_json, affected_paths_json, acceptance_criteria, creator_agent_id, creator_session_id,
        assignee_agent_id, resolved_by_agent_id, commit_sha, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      1, 1, "TKT-detail", "Detail Ticket", "Ticket detail body", "in_review", "high", 7,
      JSON.stringify(["dashboard", "comments"]),
      JSON.stringify(["src/dashboard/html.ts"]),
      "Show comments",
      "reviewer-1", "session-1", "developer-1", null, "abc1234", now, now,
    );
    sqlite.prepare(`
      INSERT INTO ticket_comments (ticket_id, agent_id, session_id, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(1, "reviewer-1", "session-1", "Need dashboard visibility for comments.", now);
    sqlite.prepare(`
      INSERT INTO ticket_comments (ticket_id, agent_id, session_id, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(1, "reviewer-2", "session-2", "Follow-up from another reviewer.", "2026-03-10 09:25:20");
    sqlite.prepare(`
      INSERT INTO ticket_comments (ticket_id, agent_id, session_id, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(1, "reviewer-3", "session-3", "ISO timestamp reply should stay in order.", "2026-03-10T09:50:06.000Z");
    sqlite.prepare(`
      INSERT INTO ticket_history (ticket_id, from_status, to_status, agent_id, session_id, comment, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(1, "in_progress", "in_review", "developer-1", "session-2", "Ready for review", now);
    sqlite.prepare(`
      INSERT INTO patches (
        repo_id, proposal_id, base_commit, bundle_id, state, diff, message,
        touched_paths_json, dry_run_result_json, agent_id, session_id, committed_sha, ticket_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, "patch-ticket", "abc1234", null, "validated", "---", "Wire dashboard ticket detail", "[]", "{}", "developer-1", "session-2", null, 1, now, now);

    const detail = getTicketDetail(deps, "TKT-detail");

    expect(detail?.ticketId).toBe("TKT-detail");
    expect(detail?.nextActionHint).toMatchObject({
      kind: "assignee",
      label: "Assignee likely next",
      agentId: "developer-1",
    });
    expect(detail?.comments).toHaveLength(3);
    expect(detail?.comments?.map((comment) => comment.content)).toEqual([
      "Follow-up from another reviewer.",
      "ISO timestamp reply should stay in order.",
      "Need dashboard visibility for comments.",
    ]);
    expect(detail?.comments[2]?.agentName).toBe("Claude Review");
    expect(detail?.comments[2]?.agentType).toBe("claude");
    expect(detail?.comments[2]?.content).toContain("dashboard visibility");
    expect(detail?.history).toHaveLength(1);
    expect(detail?.linkedPatches).toHaveLength(1);
    expect(detail?.linkedPatches[0]?.proposalId).toBe("patch-ticket");
  });

  it("returns null for a missing ticket detail", () => {
    expect(getTicketDetail(deps, "TKT-missing")).toBeNull();
  });

  it("treats ready_for_commit tickets as assignee- or operator-next work", () => {
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("developer-1", "Dev One", "codex", "developer", "A", now);
    sqlite.prepare(`
      INSERT INTO tickets (
        id, repo_id, ticket_id, title, description, status, severity, priority,
        creator_agent_id, creator_session_id, assignee_agent_id, commit_sha, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      11, 1, "TKT-ready-assigned", "Ready Assigned", "Desc", "ready_for_commit", "high", 7,
      "reviewer-1", "session-1", "developer-1", "abc1234", now, now,
    );
    sqlite.prepare(`
      INSERT INTO tickets (
        id, repo_id, ticket_id, title, description, status, severity, priority,
        creator_agent_id, creator_session_id, assignee_agent_id, commit_sha, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      12, 1, "TKT-ready-unassigned", "Ready Unassigned", "Desc", "ready_for_commit", "medium", 5,
      "reviewer-1", "session-1", null, "abc1234", now, now,
    );

    expect(getTicketDetail(deps, "TKT-ready-assigned")?.nextActionHint).toMatchObject({
      kind: "assignee",
      label: "Assignee likely next",
      agentId: "developer-1",
      agentName: "Dev One",
    });
    expect(getTicketDetail(deps, "TKT-ready-unassigned")?.nextActionHint).toMatchObject({
      kind: "operator",
      label: "Operator likely next",
      agentId: null,
    });
  });

  it("returns dependency graph with resolved internal edges", () => {
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "src/index.ts", "typescript", "h1", "entry", "[]", now, "abc");
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "src/utils.ts", "typescript", "h2", "utils", "[]", now, "abc");
    sqlite.prepare(`INSERT INTO imports (source_file_id, target_path, kind) VALUES (?, ?, ?)`)
      .run(1, "./utils.js", "import");

    const result = getDependencyGraph(deps);
    expect(result.nodes).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ source: 1, target: 2, kind: "import" });
    expect(result.cycleCount).toBe(0);
  });

  it("detects circular dependencies in graph", () => {
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "src/a.ts", "typescript", "h1", "a", "[]", now, "abc");
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "src/b.ts", "typescript", "h2", "b", "[]", now, "abc");
    sqlite.prepare(`INSERT INTO imports (source_file_id, target_path, kind) VALUES (?, ?, ?)`)
      .run(1, "src/b.ts", "import");
    sqlite.prepare(`INSERT INTO imports (source_file_id, target_path, kind) VALUES (?, ?, ?)`)
      .run(2, "src/a.ts", "import");

    const result = getDependencyGraph(deps);
    expect(result.cycleCount).toBe(2);
    expect(result.nodes.filter((n) => n.inCycle)).toHaveLength(2);
  });

  it("filters dependency graph by scope prefix", () => {
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "src/app.ts", "typescript", "h1", "app", "[]", now, "abc");
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "test/app.test.ts", "typescript", "h2", "test", "[]", now, "abc");

    const scoped = getDependencyGraph(deps, "src/");
    expect(scoped.nodes).toHaveLength(1);
    expect(scoped.nodes[0]?.path).toBe("src/app.ts");
  });

  it("expands a focused file into its direct dependency neighborhood", () => {
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "src/a.ts", "typescript", "h1", "a", "[]", now, "abc");
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "src/b.ts", "typescript", "h2", "b", "[]", now, "abc");
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "src/c.ts", "typescript", "h3", "c", "[]", now, "abc");
    sqlite.prepare(`INSERT INTO imports (source_file_id, target_path, kind) VALUES (?, ?, ?)`)
      .run(1, "./b.js", "import");
    sqlite.prepare(`INSERT INTO imports (source_file_id, target_path, kind) VALUES (?, ?, ?)`)
      .run(3, "./a.js", "import");

    const focused = getDependencyGraph(deps, "src/a.ts");
    expect(focused.nodes.map((node) => node.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(focused.edges).toHaveLength(2);
  });

  it("builds a read-only knowledge graph from exact relationships", () => {
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "src/app.ts", "typescript", "h1", "app", "[]", now, "abc");
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "src/lib.ts", "typescript", "h2", "lib", "[]", now, "abc");
    sqlite.prepare(`INSERT INTO imports (source_file_id, target_path, kind) VALUES (?, ?, ?)`)
      .run(1, "./lib.js", "import");

    sqlite.prepare(`INSERT INTO tickets (repo_id, ticket_id, title, description, status, severity, priority, tags_json, affected_paths_json, acceptance_criteria, creator_agent_id, creator_session_id, commit_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "TKT-graph-a", "Graph A", "Desc", "technical_analysis", "medium", 5, "[]", JSON.stringify(["src/app.ts"]), null, "agent-a", "session-a", "abc", now, now);
    sqlite.prepare(`INSERT INTO tickets (repo_id, ticket_id, title, description, status, severity, priority, tags_json, affected_paths_json, acceptance_criteria, creator_agent_id, creator_session_id, commit_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "TKT-graph-b", "Graph B", "Desc", "approved", "medium", 4, "[]", "[]", null, "agent-b", "session-b", "abc", now, now);
    sqlite.prepare(`INSERT INTO ticket_dependencies (from_ticket_id, to_ticket_id, relation_type, created_by_agent_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(1, 2, "blocks", "agent-a", now);

    sqlite.prepare(`INSERT INTO patches (repo_id, proposal_id, base_commit, bundle_id, state, diff, message, touched_paths_json, dry_run_result_json, agent_id, session_id, committed_sha, ticket_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "PATCH-1", "abc", null, "proposed", "diff", "Patch message", JSON.stringify(["src/lib.ts"]), null, "agent-a", "session-a", null, 1, now, now);

    sqlite.prepare(`INSERT INTO notes (repo_id, type, key, content, metadata_json, linked_paths_json, agent_id, session_id, commit_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "decision", "note:graph", "Follow-up for TKT-graph-b", null, JSON.stringify(["src/lib.ts"]), "agent-a", "session-a", "abc", now, now);

    sqlite.prepare(`INSERT INTO knowledge (key, type, scope, title, content, tags_json, status, agent_id, session_id, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("pattern:graph", "pattern", "repo", "Graph Pattern", "See src/lib.ts and TKT-graph-a for context.", "[]", "active", "agent-a", "session-a", null, now, now);

    const result = getKnowledgeGraph(deps);
    const edgeTypes = result.edges.map((edge) => edge.edgeType);
    const importsEdge = result.edges.find((edge) => edge.edgeType === "imports");
    const noteSupportEdge = result.edges.find((edge) => edge.edgeType === "supports_ticket" && edge.source === "note:note:graph");
    const knowledgeFileEdge = result.edges.find((edge) => edge.edgeType === "documents_file");

    expect(result.defaultThreshold).toBe(0.65);
    expect(result.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      "file:src/app.ts",
      "file:src/lib.ts",
      "ticket:TKT-graph-a",
      "ticket:TKT-graph-b",
      "patch:PATCH-1",
      "note:note:graph",
      "knowledge:pattern:graph",
    ]));
    expect(edgeTypes).toEqual(expect.arrayContaining([
      "imports",
      "blocks",
      "addresses_file",
      "touches_file",
      "implements_ticket",
      "annotates_file",
      "documents_file",
      "supports_ticket",
    ]));
    for (const edge of result.edges) {
      expect(edge.score).toBeGreaterThanOrEqual(result.defaultThreshold);
      expect(edge.provenance).toEqual(expect.objectContaining({
        kind: expect.any(String),
        detail: expect.any(String),
      }));
    }
    expect(importsEdge).toEqual(expect.objectContaining({
      provenance: expect.objectContaining({
        kind: "imports_index",
        detail: "src/app.ts -> src/lib.ts",
      }),
    }));
    expect(noteSupportEdge).toEqual(expect.objectContaining({
      provenance: expect.objectContaining({
        kind: "note.ticket_ref",
        detail: "note:graph",
      }),
    }));
    expect(knowledgeFileEdge).toEqual(expect.objectContaining({
      provenance: expect.objectContaining({
        kind: "knowledge.file_ref",
        detail: "pattern:graph",
      }),
    }));
  });

  it("keeps knowledge graph joins exact and de-duplicates symmetric relations", () => {
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "src/app.ts", "typescript", "h1", "app", "[]", now, "abc");

    sqlite.prepare(`INSERT INTO tickets (repo_id, ticket_id, title, description, status, severity, priority, tags_json, affected_paths_json, acceptance_criteria, creator_agent_id, creator_session_id, commit_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "TKT-rel-a", "Rel A", "Desc", "approved", "medium", 5, "[]", JSON.stringify(["src/app.ts", "missing.ts"]), null, "agent-a", "session-a", "abc", now, now);
    sqlite.prepare(`INSERT INTO tickets (repo_id, ticket_id, title, description, status, severity, priority, tags_json, affected_paths_json, acceptance_criteria, creator_agent_id, creator_session_id, commit_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "TKT-rel-b", "Rel B", "Desc", "approved", "medium", 5, "[]", "[]", null, "agent-b", "session-b", "abc", now, now);
    sqlite.prepare(`INSERT INTO ticket_dependencies (from_ticket_id, to_ticket_id, relation_type, created_by_agent_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(1, 2, "relates_to", "agent-a", now);

    sqlite.prepare(`INSERT INTO notes (repo_id, type, key, content, metadata_json, linked_paths_json, agent_id, session_id, commit_sha, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(1, "context", "note:exact", "Only explicit paths count", null, JSON.stringify(["missing.ts"]), "agent-a", "session-a", "abc", now, now);
    sqlite.prepare(`INSERT INTO knowledge (key, type, scope, title, content, tags_json, status, agent_id, session_id, embedding, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("context:exact", "context", "repo", "Exact paths only", "This references missing.ts but not the indexed file.", "[]", "active", "agent-a", "session-a", null, now, now);

    const result = getKnowledgeGraph(deps);
    const relatesToEdges = result.edges.filter((edge) => edge.edgeType === "relates_to");

    expect(relatesToEdges).toHaveLength(1);
    expect(result.nodes.map((node) => node.id)).not.toContain("file:missing.ts");
    expect(result.edges.some((edge) => edge.edgeType === "annotates_file")).toBe(false);
    expect(result.edges.some((edge) => edge.edgeType === "documents_file")).toBe(false);
  });
});
