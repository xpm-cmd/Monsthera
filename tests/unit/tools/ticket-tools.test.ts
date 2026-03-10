import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { registerTicketTools } from "../../../src/tools/ticket-tools.js";

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<any>>();

  tool(name: string, _description: string, _schema: object, handler: (input: unknown) => Promise<any>) {
    this.handlers.set(name, handler);
  }
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), from_status TEXT, to_status TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, comment TEXT, timestamp TEXT NOT NULL);
    CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("ticket tools", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let repoId: number;
  const now = new Date().toISOString();

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;

    server = new FakeServer();
    registerTicketTools(server as unknown as McpServer, async () => ({
      db,
      repoId,
      insight: { info: () => undefined, warn: () => undefined },
    } as any));

    for (const ticket of [
      { ticketId: "TKT-other-1", title: "Other 1", priority: 10, tagsJson: JSON.stringify(["other"]) },
      { ticketId: "TKT-other-2", title: "Other 2", priority: 9, tagsJson: JSON.stringify(["other"]) },
      { ticketId: "TKT-bug-1", title: "Bug 1", priority: 8, tagsJson: JSON.stringify(["bug"]) },
      { ticketId: "TKT-bug-2", title: "Bug 2", priority: 7, tagsJson: JSON.stringify(["bug"]) },
    ]) {
      queries.insertTicket(db, {
        repoId,
        ticketId: ticket.ticketId,
        title: ticket.title,
        description: "Desc",
        status: "backlog",
        severity: "high",
        priority: ticket.priority,
        tagsJson: ticket.tagsJson,
        creatorAgentId: "reviewer-1",
        creatorSessionId: "session-1",
        commitSha: "abc1234",
        createdAt: now,
        updatedAt: now,
      });
    }
  });

  afterEach(() => sqlite.close());

  it("applies limit after tags filtering in list_tickets", async () => {
    const listTickets = server.handlers.get("list_tickets");
    expect(listTickets).toBeTypeOf("function");

    const result = await listTickets!({ tags: ["bug"], limit: 2 });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.count).toBe(2);
    expect(payload.tickets.map((ticket: { ticketId: string }) => ticket.ticketId)).toEqual(["TKT-bug-1", "TKT-bug-2"]);
  });
});
