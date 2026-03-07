import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { logEvent, cleanupExpiredPayloads } from "../../../src/logging/event-logger.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  for (const stmt of [
    `CREATE TABLE event_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, tool TEXT NOT NULL, timestamp TEXT NOT NULL, duration_ms REAL NOT NULL, status TEXT NOT NULL, repo_id TEXT NOT NULL, commit_scope TEXT NOT NULL, payload_size_in INTEGER NOT NULL, payload_size_out INTEGER NOT NULL, input_hash TEXT NOT NULL, output_hash TEXT NOT NULL, redacted_summary TEXT NOT NULL, denial_reason TEXT)`,
    `CREATE TABLE debug_payloads (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL REFERENCES event_logs(event_id), raw_input TEXT, raw_output TEXT, expires_at TEXT NOT NULL)`,
  ]) {
    sqlite.prepare(stmt).run();
  }
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("Event Logger", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    sqlite = result.sqlite;
  });
  afterEach(() => sqlite.close());

  it("logs an event with metadata", () => {
    const eventId = logEvent(db, {
      agentId: "a1",
      sessionId: "s1",
      tool: "get_code_pack",
      repoId: "r1",
      commitScope: "abc123",
      input: '{"query":"test"}',
      output: '{"bundleId":"b1"}',
      status: "success",
      durationMs: 50,
    }, false);

    expect(eventId).toMatch(/^evt-/);

    const rows = sqlite.prepare("SELECT * FROM event_logs").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool).toBe("get_code_pack");
    expect(rows[0]!.status).toBe("success");
    expect(rows[0]!.input_hash).toBeTruthy();
  });

  it("does not store debug payloads when disabled", () => {
    logEvent(db, {
      agentId: "a1", sessionId: "s1", tool: "test",
      repoId: "r1", commitScope: "abc", input: "in", output: "out",
      status: "success", durationMs: 10,
    }, false);

    const payloads = sqlite.prepare("SELECT * FROM debug_payloads").all();
    expect(payloads).toHaveLength(0);
  });

  it("stores debug payloads when enabled", () => {
    logEvent(db, {
      agentId: "a1", sessionId: "s1", tool: "test",
      repoId: "r1", commitScope: "abc", input: "in", output: "out",
      status: "success", durationMs: 10,
    }, true);

    const payloads = sqlite.prepare("SELECT * FROM debug_payloads").all() as Array<Record<string, unknown>>;
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.raw_input).toBe("in");
  });

  it("redacts secrets in debug payloads", () => {
    logEvent(db, {
      agentId: "a1", sessionId: "s1", tool: "test",
      repoId: "r1", commitScope: "abc",
      input: 'password: "my-super-secret-password"',
      output: "ok",
      status: "success", durationMs: 10,
    }, true);

    const payloads = sqlite.prepare("SELECT * FROM debug_payloads").all() as Array<Record<string, unknown>>;
    expect(payloads[0]!.raw_input).toContain("[REDACTED]");
  });

  it("logs denial reason", () => {
    logEvent(db, {
      agentId: "a1", sessionId: "s1", tool: "propose_patch",
      repoId: "r1", commitScope: "abc", input: "{}", output: "{}",
      status: "denied", durationMs: 1,
      denialReason: "Observer cannot propose patches",
    }, false);

    const rows = sqlite.prepare("SELECT * FROM event_logs").all() as Array<Record<string, unknown>>;
    expect(rows[0]!.denial_reason).toBe("Observer cannot propose patches");
  });

  it("cleans expired payloads", () => {
    // Insert an expired payload manually
    const eventId = logEvent(db, {
      agentId: "a1", sessionId: "s1", tool: "test",
      repoId: "r1", commitScope: "abc", input: "x", output: "y",
      status: "success", durationMs: 1,
    }, false);

    sqlite.prepare("INSERT INTO debug_payloads (event_id, raw_input, raw_output, expires_at) VALUES (?, ?, ?, ?)")
      .run(eventId, "old-in", "old-out", "2020-01-01T00:00:00.000Z");

    cleanupExpiredPayloads(db);

    const payloads = sqlite.prepare("SELECT * FROM debug_payloads").all();
    expect(payloads).toHaveLength(0);
  });
});
