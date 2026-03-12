import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { registerAgentTools } from "../../../src/tools/agent-tools.js";
import {
  installToolRuntimeInstrumentation,
  resetToolRateLimitState,
} from "../../../src/tools/runtime-instrumentation.js";
import { getToolRunner } from "../../../src/tools/tool-runner.js";

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
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', provider TEXT, model TEXT, model_family TEXT, model_version TEXT, identity_source TEXT, role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT);
    CREATE TABLE index_state (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, db_indexed_commit TEXT, zoekt_indexed_commit TEXT, indexed_at TEXT, last_success TEXT, last_error TEXT);
    CREATE TABLE event_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, tool TEXT NOT NULL, timestamp TEXT NOT NULL, duration_ms REAL NOT NULL, status TEXT NOT NULL, repo_id TEXT NOT NULL, commit_scope TEXT NOT NULL, payload_size_in INTEGER NOT NULL, payload_size_out INTEGER NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT NOT NULL, redacted_summary TEXT NOT NULL, error_code TEXT, error_detail TEXT, denial_reason TEXT);
    CREATE TABLE debug_payloads (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES event_logs(event_id), raw_input TEXT, raw_output TEXT, expires_at TEXT NOT NULL);
  `);
  sqlite.prepare(`INSERT INTO index_state (repo_id, db_indexed_commit) VALUES (?, ?)`).run(1, "abc1234");
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("tool runner", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let runner: ReturnType<typeof getToolRunner>;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    resetToolRateLimitState();
    server = new FakeServer();

    installToolRuntimeInstrumentation(server as unknown as McpServer, async () => ({
      config: {
        debugLogging: false,
        toolRateLimits: {
          defaultPerMinute: 10,
        },
      },
      db,
      repoId: 1,
      repoPath: "/test",
      insight: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    } as any));

    registerAgentTools(server as unknown as McpServer, async () => ({
      config: {
        debugLogging: false,
        toolRateLimits: {
          defaultPerMinute: 10,
        },
      },
      db,
      repoId: 1,
      repoPath: "/test",
      insight: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    } as any));
    runner = getToolRunner(server as unknown as McpServer);
  });

  afterEach(() => {
    resetToolRateLimitState();
    sqlite.close();
  });

  it("captures instrumented handlers and runs successful internal calls through the audited path", async () => {
    const now = new Date().toISOString();
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

    expect(runner.has("claim_files")).toBe(true);

    const result = await runner.callTool("claim_files", {
      agentId: "agent-dev",
      sessionId: "session-dev",
      paths: ["src/runner.ts"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const payload = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0]!.text);
      expect(payload.claimed).toEqual(["src/runner.ts"]);
    }

    const row = sqlite.prepare("SELECT tool, status, agent_id, session_id FROM event_logs ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      tool: "claim_files",
      status: "success",
      agent_id: "agent-dev",
      session_id: "session-dev",
    });
  });

  it("normalizes permission-denied results from real tool handlers", async () => {
    const now = new Date().toISOString();
    queries.upsertAgent(db, {
      id: "agent-obs",
      name: "Observer",
      type: "test",
      roleId: "observer",
      trustTier: "B",
      registeredAt: now,
    });
    queries.insertSession(db, {
      id: "session-obs",
      agentId: "agent-obs",
      state: "active",
      connectedAt: now,
      lastActivity: now,
    });

    const result = await runner.callTool("broadcast", {
      message: "hello",
      agentId: "agent-obs",
      sessionId: "session-obs",
    });

    expect(result).toMatchObject({
      ok: false,
      tool: "broadcast",
      errorCode: "denied",
    });

    const row = sqlite.prepare("SELECT tool, status, error_code, denial_reason FROM event_logs ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      tool: "broadcast",
      status: "denied",
      error_code: "denied",
    });
    expect(String(row.denial_reason)).toContain("does not have access");
  });

  it("returns a normalized tool_not_found error for unknown tools", async () => {
    const result = await runner.callTool("missing_tool", {});

    expect(result).toEqual({
      ok: false,
      tool: "missing_tool",
      errorCode: "tool_not_found",
      message: "Tool not found: missing_tool",
      causeCode: "tool_not_found",
    });
    const count = sqlite.prepare("SELECT COUNT(*) as count FROM event_logs").get() as { count: number };
    expect(count.count).toBe(0);
  });

  it("normalizes thrown execution failures from instrumented handlers", async () => {
    server.tool("explode", "explode", {}, async () => {
      throw new Error("boom");
    });

    const result = await runner.callTool("explode", {
      agentId: "agent-dev",
      sessionId: "session-dev",
    });

    expect(result).toMatchObject({
      ok: false,
      tool: "explode",
      errorCode: "execution_failed",
      message: "Tool execution failed (Error)",
    });

    const row = sqlite.prepare("SELECT tool, status, error_code, error_detail FROM event_logs ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      tool: "explode",
      status: "error",
      error_code: "error",
      error_detail: "boom",
    });
  });
});
