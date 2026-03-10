import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { CoordinationBus } from "../../../src/coordination/bus.js";
import { getOverview, getAgentsList, getTicketsList, getTicketDetail, getIndexedFilesMetrics, getPresence, type DashboardDeps } from "../../../src/dashboard/api.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  for (const stmt of [
    `CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE index_state (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, db_indexed_commit TEXT, zoekt_indexed_commit TEXT, indexed_at TEXT, last_success TEXT, last_error TEXT)`,
    `CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, path TEXT NOT NULL, language TEXT, content_hash TEXT, summary TEXT, symbols_json TEXT, has_secrets INTEGER DEFAULT 0, secret_line_ranges TEXT, indexed_at TEXT, commit_sha TEXT, embedding BLOB)`,
    `CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL)`,
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT)`,
    `CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, from_status TEXT, to_status TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, comment TEXT, timestamp TEXT NOT NULL)`,
    `CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL UNIQUE, content TEXT NOT NULL, metadata_json TEXT, linked_paths_json TEXT, agent_id TEXT, session_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE event_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, tool TEXT NOT NULL, timestamp TEXT NOT NULL, duration_ms REAL NOT NULL, status TEXT NOT NULL, repo_id TEXT NOT NULL, commit_scope TEXT NOT NULL, payload_size_in INTEGER NOT NULL, payload_size_out INTEGER NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT NOT NULL, redacted_summary TEXT NOT NULL, denial_reason TEXT)`,
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

    const files = getIndexedFilesMetrics(deps);

    expect(files.totalFiles).toBe(4);
    expect(files.uniqueBuckets).toBe(3);
    expect(files.topLanguages[0]).toEqual({ label: "typescript", count: 2 });
    expect(files.topLanguages[1]).toEqual({ label: ".md", count: 1 });
    expect(files.unknownFiles).toBe(1);
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

  it("returns ticket detail with comments, history, and linked patches", () => {
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("reviewer-1", "Claude Review", "claude", "reviewer", "A", now);
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
    expect(detail?.comments).toHaveLength(1);
    expect(detail?.comments[0]?.agentName).toBe("Claude Review");
    expect(detail?.comments[0]?.agentType).toBe("claude");
    expect(detail?.comments[0]?.content).toContain("dashboard visibility");
    expect(detail?.history).toHaveLength(1);
    expect(detail?.linkedPatches).toHaveLength(1);
    expect(detail?.linkedPatches[0]?.proposalId).toBe("patch-ticket");
  });

  it("returns null for a missing ticket detail", () => {
    expect(getTicketDetail(deps, "TKT-missing")).toBeNull();
  });
});
