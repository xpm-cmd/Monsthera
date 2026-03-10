import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { FTS5Backend } from "../../../src/search/fts5.js";
import { SearchRouter } from "../../../src/search/router.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, path TEXT NOT NULL, language TEXT, content_hash TEXT, summary TEXT, symbols_json TEXT, has_secrets INTEGER DEFAULT 0, secret_line_ranges TEXT, indexed_at TEXT, commit_sha TEXT, embedding BLOB);
    CREATE TABLE knowledge (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, type TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags_json TEXT, status TEXT NOT NULL DEFAULT 'active', agent_id TEXT, session_id TEXT, embedding BLOB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  sqlite.exec("INSERT INTO repos (path, name, created_at) VALUES ('/repo', 'repo', '2026-03-10T00:00:00.000Z')");
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

describe("ticket FTS", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let fts5: FTS5Backend;

  beforeEach(() => {
    ({ sqlite, db } = createTestDb());
    fts5 = new FTS5Backend(sqlite, db);
  });

  afterEach(() => sqlite.close());

  function insertTicket(values: {
    ticketId: string;
    title: string;
    description: string;
    status?: string;
    severity?: string;
    assigneeAgentId?: string | null;
    tags?: string[];
  }) {
    sqlite.prepare(`
      INSERT INTO tickets (
        repo_id, ticket_id, title, description, status, severity, priority,
        tags_json, affected_paths_json, acceptance_criteria, creator_agent_id, creator_session_id,
        assignee_agent_id, resolved_by_agent_id, commit_sha, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      1,
      values.ticketId,
      values.title,
      values.description,
      values.status ?? "backlog",
      values.severity ?? "medium",
      5,
      JSON.stringify(values.tags ?? []),
      "[]",
      null,
      "agent-review",
      "session-review",
      values.assigneeAgentId ?? null,
      null,
      "abc1234",
      "2026-03-10T00:00:00.000Z",
      "2026-03-10T00:00:00.000Z",
    );
  }

  it("ranks title matches above description-only matches", () => {
    insertTicket({
      ticketId: "TKT-title",
      title: "Dashboard repository name header",
      description: "Show context in the UI",
      tags: ["dashboard"],
    });
    insertTicket({
      ticketId: "TKT-body",
      title: "Header polish",
      description: "Add the repository name to the dashboard header for clarity",
      tags: ["dashboard"],
    });

    fts5.initTicketFts();
    fts5.rebuildTicketFts(1);

    const results = fts5.searchTickets("repository name header", 1, 10);

    expect(results).toHaveLength(2);
    expect(results[0]?.ticketId).toBe("TKT-title");
  });

  it("applies status, severity, and assignee filters in the FTS query", () => {
    insertTicket({
      ticketId: "TKT-open",
      title: "Dashboard filters broken",
      description: "Ticket search filters are not working",
      status: "in_progress",
      severity: "high",
      assigneeAgentId: "agent-dev",
      tags: ["dashboard", "search"],
    });
    insertTicket({
      ticketId: "TKT-done",
      title: "Dashboard filters follow-up",
      description: "Same topic but already resolved",
      status: "resolved",
      severity: "high",
      assigneeAgentId: "agent-dev",
      tags: ["dashboard", "search"],
    });

    fts5.initTicketFts();
    fts5.rebuildTicketFts(1);

    const results = fts5.searchTickets("dashboard filters", 1, 10, {
      status: "in_progress",
      severity: "high",
      assigneeAgentId: "agent-dev",
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.ticketId).toBe("TKT-open");
  });

  it("returns ticket search results after router startup initialization", async () => {
    insertTicket({
      ticketId: "TKT-startup",
      title: "Search tickets after startup",
      description: "Fresh serve/index cycle should populate ticket FTS",
      tags: ["search", "startup"],
    });

    const router = new SearchRouter({
      repoId: 1,
      sqlite,
      db,
      repoPath: "/repo",
      zoektEnabled: false,
      semanticEnabled: false,
      indexDir: "/tmp/agora-test",
    });
    await router.initialize();

    const results = router.searchTickets("startup ticket search", 1, 10);

    expect(results).toHaveLength(1);
    expect(results[0]?.ticketId).toBe("TKT-startup");
  });
});
