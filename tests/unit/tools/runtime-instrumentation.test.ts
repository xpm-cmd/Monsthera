import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import * as schema from "../../../src/db/schema.js";
import {
  installToolRuntimeInstrumentation,
  resetToolRateLimitState,
  classifyResultForLogging,
  getInstrumentedToolRegistry,
} from "../../../src/tools/runtime-instrumentation.js";
import { StalePatchError, PermissionDeniedError } from "../../../src/core/errors.js";

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
    CREATE TABLE event_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, tool TEXT NOT NULL, timestamp TEXT NOT NULL, duration_ms REAL NOT NULL, status TEXT NOT NULL, repo_id TEXT NOT NULL, commit_scope TEXT NOT NULL, payload_size_in INTEGER NOT NULL, payload_size_out INTEGER NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT NOT NULL, redacted_summary TEXT NOT NULL, error_code TEXT, error_detail TEXT, denial_reason TEXT);
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
    resetToolRateLimitState();
    server = new FakeServer();
    installToolRuntimeInstrumentation(server as unknown as McpServer, async () => ({
      config: {
        debugLogging: false,
        toolRateLimits: {
          defaultPerMinute: 1,
          overrides: { schema: 2 },
        },
      },
      db,
      repoId: 1,
      repoPath: "/test",
    } as any));
  });

  afterEach(() => {
    resetToolRateLimitState();
    sqlite.close();
  });

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

  it("captures input schemas alongside instrumented handlers", () => {
    const inputSchema = z.object({
      message: z.string().min(1),
    });

    server.tool("echo", "echo", inputSchema, async (input) => ({
      content: [{ type: "text", text: JSON.stringify(input) }],
    }));

    const registration = getInstrumentedToolRegistry(server as unknown as McpServer).get("echo");
    expect(registration?.inputSchema).toBe(inputSchema);
    expect(typeof registration?.handler).toBe("function");
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
    expect(row.error_code).toBe("denied");
    expect(row.error_detail).toBe("nope");
    expect(row.agent_id).toBe("agent-1");
  });

  it("logs thrown errors with normalized code and sanitized re-throw", async () => {
    server.tool("store_knowledge", "store_knowledge", {}, async () => {
      const error = new Error("sqlite busy");
      (error as Error & { code?: string }).code = "SQLITE_BUSY";
      throw error;
    });

    // Generic errors are sanitized before re-throw (internal details hidden)
    await expect(server.handlers.get("store_knowledge")!({
      agentId: "agent-2",
      sessionId: "session-2",
    })).rejects.toThrow("Tool execution failed (Error)");

    // But telemetry still records the original detail
    const row = sqlite.prepare("SELECT * FROM event_logs").get() as Record<string, unknown>;
    expect(row.tool).toBe("store_knowledge");
    expect(row.status).toBe("error");
    expect(row.error_code).toBe("sqlite_busy");
    expect(row.error_detail).toBe("sqlite busy");
  });

  it("rate limits repeated calls per tool and logs them as denied", async () => {
    server.tool("status", "status", {}, async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    }));

    const first = await server.handlers.get("status")!({});
    const second = await server.handlers.get("status")!({});

    expect(first.isError).toBeUndefined();
    expect(second.isError).toBe(true);
    expect(JSON.parse(second.content[0].text)).toMatchObject({
      denied: true,
      errorCode: "rate_limited",
      limitPerMinute: 1,
    });

    const rows = sqlite.prepare("SELECT status, error_code, denial_reason FROM event_logs ORDER BY id").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      status: "denied",
      error_code: "rate_limited",
      denial_reason: "Rate limit exceeded for status",
    });
  });

  it("supports per-tool rate limit overrides", async () => {
    server.tool("schema", "schema", {}, async () => ({
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    }));

    const first = await server.handlers.get("schema")!({});
    const second = await server.handlers.get("schema")!({});
    const third = await server.handlers.get("schema")!({});

    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect(third.isError).toBe(true);
    expect(JSON.parse(third.content[0].text)).toMatchObject({
      errorCode: "rate_limited",
      limitPerMinute: 2,
    });
  });

  it("does not misclassify success results mentioning 'stale' in text", async () => {
    server.tool("list_patches", "list_patches", {}, async () => ({
      content: [{ type: "text", text: JSON.stringify({ patches: [{ note: "this patch is stale" }] }) }],
    }));

    await server.handlers.get("list_patches")!({});

    const row = sqlite.prepare("SELECT status FROM event_logs").get() as Record<string, unknown>;
    expect(row.status).toBe("success");
  });

  it("classifies thrown StalePatchError by structured code", async () => {
    server.tool("propose_patch", "propose_patch", {}, async () => {
      throw new StalePatchError("abc123", "def456");
    });

    // AgoraError is re-thrown as-is (not sanitized)
    await expect(server.handlers.get("propose_patch")!({
      agentId: "agent-3",
      sessionId: "session-3",
    })).rejects.toThrow("Patch base commit");

    const row = sqlite.prepare("SELECT status, error_code, error_detail FROM event_logs").get() as Record<string, unknown>;
    expect(row.status).toBe("stale");
    expect(row.error_code).toBe("stale_patch");
    expect(row.error_detail).toContain("abc123");
  });

  it("classifies thrown PermissionDeniedError as denied", async () => {
    server.tool("claim_files_denied", "test", {}, async () => {
      throw new PermissionDeniedError("agent-x", "claim_files", "insufficient trust tier");
    });

    await expect(server.handlers.get("claim_files_denied")!({
      agentId: "agent-x",
      sessionId: "session-x",
    })).rejects.toThrow("denied access");

    const row = sqlite.prepare("SELECT status, error_code FROM event_logs").get() as Record<string, unknown>;
    expect(row.status).toBe("denied");
    expect(row.error_code).toBe("permission_denied");
  });

  it("classifies result with structured errorCode over regex", async () => {
    server.tool("test_structured", "test", {}, async () => ({
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ errorCode: "STALE_PATCH", message: "outdated" }) }],
    }));

    await server.handlers.get("test_structured")!({});

    const row = sqlite.prepare("SELECT status, error_code FROM event_logs").get() as Record<string, unknown>;
    expect(row.status).toBe("stale");
    expect(row.error_code).toBe("stale_patch");
  });
});

describe("classifyResultForLogging", () => {
  it("returns success for non-error results mentioning stale", () => {
    const result = {
      content: [{ type: "text", text: JSON.stringify({ message: "patch is stale, please refresh" }) }],
    };
    expect(classifyResultForLogging(result)).toMatchObject({ status: "success" });
  });

  it("returns stale for non-error results with stale boolean flag", () => {
    const result = {
      content: [{ type: "text", text: JSON.stringify({ stale: true, reason: "commit mismatch" }) }],
    };
    expect(classifyResultForLogging(result)).toMatchObject({ status: "stale" });
  });

  it("returns denied for error results with structured denied code", () => {
    const result = {
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ errorCode: "PERMISSION_DENIED", reason: "nope" }) }],
    };
    const classified = classifyResultForLogging(result);
    expect(classified.status).toBe("denied");
    expect(classified.errorCode).toBe("permission_denied");
  });
});
