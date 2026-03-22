import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { resolveAgent } from "../../../src/tools/resolve-agent.js";
import type { MonstheraContext } from "../../../src/core/context.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', provider TEXT, model TEXT, model_family TEXT, model_version TEXT, identity_source TEXT, role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT, worktree_path TEXT, worktree_branch TEXT);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

function seedAgent(sqlite: InstanceType<typeof Database>, agentId: string, role = "developer", tier = "A") {
  sqlite.prepare("INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(agentId, "Test", "claude-code", role, tier, new Date().toISOString());
}

function seedSession(sqlite: InstanceType<typeof Database>, sessionId: string, agentId: string, state = "active") {
  const now = new Date().toISOString();
  sqlite.prepare("INSERT INTO sessions (id, agent_id, state, connected_at, last_activity) VALUES (?, ?, ?, ?, ?)")
    .run(sessionId, agentId, state, now, now);
}

describe("resolveAgent", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;
  let ctx: MonstheraContext;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    ctx = { db } as unknown as MonstheraContext;
    seedAgent(sqlite, "agent-1", "developer", "A");
    seedSession(sqlite, "session-1", "agent-1");
  });

  afterEach(() => sqlite.close());

  it("returns error when agentId is missing", () => {
    const result = resolveAgent(ctx, undefined, "session-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Missing agentId or sessionId");
  });

  it("returns error when sessionId is missing", () => {
    const result = resolveAgent(ctx, "agent-1", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Missing agentId or sessionId");
  });

  it("returns error when both are missing", () => {
    const result = resolveAgent(ctx, undefined, undefined);
    expect(result.ok).toBe(false);
  });

  it("returns error when agent does not exist", () => {
    const result = resolveAgent(ctx, "agent-unknown", "session-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Agent not found");
  });

  it("returns error when session does not exist", () => {
    const result = resolveAgent(ctx, "agent-1", "session-unknown");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Session not found");
  });

  it("returns error when session belongs to a different agent", () => {
    seedAgent(sqlite, "agent-2", "observer", "B");
    seedSession(sqlite, "session-2", "agent-2");

    const result = resolveAgent(ctx, "agent-1", "session-2");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("belongs to a different agent");
  });

  it("returns error when session is disconnected", () => {
    seedSession(sqlite, "session-disconnected", "agent-1", "disconnected");

    const result = resolveAgent(ctx, "agent-1", "session-disconnected");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("disconnected");
  });

  it("returns resolved agent with correct fields for valid input", () => {
    const result = resolveAgent(ctx, "agent-1", "session-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agent.agentId).toBe("agent-1");
      expect(result.agent.sessionId).toBe("session-1");
      expect(result.agent.role).toBe("developer");
      expect(result.agent.trustTier).toBe("A");
    }
  });

  it("updates lastActivity on successful resolution (presence tracking)", () => {
    sqlite.prepare("UPDATE sessions SET last_activity = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", "session-1");

    const before = sqlite.prepare("SELECT last_activity FROM sessions WHERE id = ?")
      .get("session-1") as { last_activity: string };

    const result = resolveAgent(ctx, "agent-1", "session-1");
    expect(result.ok).toBe(true);

    const after = sqlite.prepare("SELECT last_activity FROM sessions WHERE id = ?")
      .get("session-1") as { last_activity: string };

    expect(new Date(after.last_activity).getTime()).toBeGreaterThan(
      new Date(before.last_activity).getTime(),
    );
  });

  it("resolves observer agent with Tier B", () => {
    seedAgent(sqlite, "agent-obs", "observer", "B");
    seedSession(sqlite, "session-obs", "agent-obs");

    const result = resolveAgent(ctx, "agent-obs", "session-obs");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.agent.role).toBe("observer");
      expect(result.agent.trustTier).toBe("B");
    }
  });
});
