import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { exportAuditTrail } from "../../../src/export/audit.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS event_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL DEFAULT '',
      tool TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL DEFAULT '',
      duration_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'success',
      repo_id TEXT NOT NULL DEFAULT '',
      commit_scope TEXT NOT NULL DEFAULT '',
      payload_size_in INTEGER NOT NULL DEFAULT 0,
      payload_size_out INTEGER NOT NULL DEFAULT 0,
      input_hash TEXT NOT NULL DEFAULT '',
      output_hash TEXT NOT NULL DEFAULT '',
      redacted_summary TEXT NOT NULL DEFAULT '',
      denial_reason TEXT
    );
  `);
  return { db, sqlite };
}

function insertEvent(sqlite: Database.Database, overrides: Record<string, unknown> = {}) {
  const defaults = {
    event_id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    agent_id: "agent-1",
    session_id: "session-1",
    tool: "get_code_pack",
    timestamp: "2026-03-10T10:00:00Z",
    duration_ms: 42,
    status: "success",
    repo_id: "repo-1",
    commit_scope: "abc123",
    payload_size_in: 100,
    payload_size_out: 200,
    input_hash: "sha256:aaa",
    output_hash: "sha256:bbb",
    redacted_summary: "searched for foo",
    denial_reason: null,
  };
  const row = { ...defaults, ...overrides };
  sqlite.prepare(`
    INSERT INTO event_logs (event_id, agent_id, session_id, tool, timestamp, duration_ms,
      status, repo_id, commit_scope, payload_size_in, payload_size_out,
      input_hash, output_hash, redacted_summary, denial_reason)
    VALUES (@event_id, @agent_id, @session_id, @tool, @timestamp, @duration_ms,
      @status, @repo_id, @commit_scope, @payload_size_in, @payload_size_out,
      @input_hash, @output_hash, @redacted_summary, @denial_reason)
  `).run(row);
}

describe("exportAuditTrail", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: Database.Database;

  beforeEach(() => {
    const t = createTestDb();
    db = t.db;
    sqlite = t.sqlite;
  });

  it("returns empty JSON for no events", () => {
    const result = exportAuditTrail({ db, format: "json" });
    expect(result.rows).toBe(0);
    const parsed = JSON.parse(result.content);
    expect(parsed.exportVersion).toBe(1);
    expect(parsed.events).toEqual([]);
  });

  it("exports events as JSON with metadata", () => {
    insertEvent(sqlite);
    insertEvent(sqlite, { event_id: "evt-2", tool: "propose_patch" });
    const result = exportAuditTrail({ db, format: "json" });
    expect(result.rows).toBe(2);
    const parsed = JSON.parse(result.content);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.exportedAt).toBeDefined();
  });

  it("exports CSV with headers", () => {
    insertEvent(sqlite);
    const result = exportAuditTrail({ db, format: "csv" });
    const lines = result.content.split("\n");
    expect(lines[0]).toContain("eventId,agentId,sessionId,tool");
    expect(lines).toHaveLength(2); // header + 1 row
  });

  it("escapes CSV fields with commas and quotes", () => {
    insertEvent(sqlite, { redacted_summary: 'searched for "foo, bar"' });
    const result = exportAuditTrail({ db, format: "csv" });
    expect(result.content).toContain('"searched for ""foo, bar"""');
  });

  it("filters by agentId", () => {
    insertEvent(sqlite, { agent_id: "agent-A" });
    insertEvent(sqlite, { agent_id: "agent-B" });
    const result = exportAuditTrail({ db, format: "json", agentId: "agent-A" });
    expect(result.rows).toBe(1);
    const parsed = JSON.parse(result.content);
    expect(parsed.events[0].agentId).toBe("agent-A");
  });

  it("filters by sessionId", () => {
    insertEvent(sqlite, { session_id: "sess-X" });
    insertEvent(sqlite, { session_id: "sess-Y" });
    const result = exportAuditTrail({ db, format: "json", sessionId: "sess-X" });
    expect(result.rows).toBe(1);
  });

  it("filters by date range", () => {
    insertEvent(sqlite, { timestamp: "2026-03-01T00:00:00Z" });
    insertEvent(sqlite, { timestamp: "2026-03-10T00:00:00Z" });
    insertEvent(sqlite, { timestamp: "2026-03-20T00:00:00Z" });
    const result = exportAuditTrail({
      db, format: "json",
      since: "2026-03-05T00:00:00Z",
      until: "2026-03-15T00:00:00Z",
    });
    expect(result.rows).toBe(1);
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      insertEvent(sqlite);
    }
    const result = exportAuditTrail({ db, format: "json", limit: 3 });
    expect(result.rows).toBe(3);
  });
});
