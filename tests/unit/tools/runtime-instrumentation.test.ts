import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import { installToolRuntimeInstrumentation } from "../../../src/tools/runtime-instrumentation.js";

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<any>>();

  tool(name: string, _description: string, _schema: object, handler: (input: unknown) => Promise<any>) {
    this.handlers.set(name, handler);
  }
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE index_state (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, db_indexed_commit TEXT, zoekt_indexed_commit TEXT, indexed_at TEXT, last_success TEXT, last_error TEXT);
    CREATE TABLE event_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, tool TEXT NOT NULL, timestamp TEXT NOT NULL, duration_ms REAL NOT NULL, status TEXT NOT NULL, repo_id TEXT NOT NULL, commit_scope TEXT NOT NULL, payload_size_in INTEGER NOT NULL, payload_size_out INTEGER NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT NOT NULL, redacted_summary TEXT NOT NULL, denial_reason TEXT);
    CREATE TABLE debug_payloads (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES event_logs(event_id), raw_input TEXT, raw_output TEXT, expires_at TEXT NOT NULL);
  `);
  sqlite.prepare(`INSERT INTO index_state (repo_id, db_indexed_commit) VALUES (?, ?)`).run(1, "abc1234");
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("runtime instrumentation", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    server = new FakeServer();
    installToolRuntimeInstrumentation(server as unknown as McpServer, async () => ({
      config: { debugLogging: false },
      db,
      repoId: 1,
      repoPath: "/test",
    } as any));
  });

  afterEach(() => sqlite.close());

  it("logs successful public tool calls with fallback actor metadata", async () => {
    server.tool("status", "status", {}, async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    }));

    await server.handlers.get("status")!({});

    const row = sqlite.prepare("SELECT * FROM event_logs").get() as Record<string, unknown>;
    expect(row.tool).toBe("status");
    expect(row.status).toBe("success");
    expect(row.agent_id).toBe("public");
    expect(row.commit_scope).toBe("abc1234");
  });

  it("logs denied outcomes and preserves the denial reason", async () => {
    server.tool("claim_files", "claim_files", {}, async () => ({
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ denied: true, reason: "nope" }) }],
    }));

    await server.handlers.get("claim_files")!({
      agentId: "agent-1",
      sessionId: "session-1",
    });

    const row = sqlite.prepare("SELECT * FROM event_logs").get() as Record<string, unknown>;
    expect(row.tool).toBe("claim_files");
    expect(row.status).toBe("denied");
    expect(row.denial_reason).toBe("nope");
    expect(row.agent_id).toBe("agent-1");
  });
});
