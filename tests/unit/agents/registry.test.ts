import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { AgentRegistrationError, registerAgent, getAgentStatus, disconnectSession } from "../../../src/agents/registry.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  for (const stmt of [
    `CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL)`,
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT)`,
  ]) {
    sqlite.prepare(stmt).run();
  }
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("Agent Registry", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    sqlite = result.sqlite;
  });
  afterEach(() => sqlite.close());

  it("registers an agent with session", () => {
    const result = registerAgent(db, { name: "Test", type: "claude-code", desiredRole: "developer" });

    expect(result.agentId).toMatch(/^agent-/);
    expect(result.sessionId).toMatch(/^session-/);
    expect(result.role).toBe("developer");
    expect(result.trustTier).toBe("A");
  });

  it("assigns Tier B to observers", () => {
    const result = registerAgent(db, { name: "Obs", type: "unknown", desiredRole: "observer" });
    expect(result.trustTier).toBe("B");
  });

  it("requires a matching auth token for privileged roles when registrationAuth is enabled", () => {
    expect(() => registerAgent(
      db,
      { name: "Dev", type: "test", desiredRole: "developer" },
      {
        registrationAuth: {
          enabled: true,
          observerOpenRegistration: true,
          roleTokens: { developer: "dev-secret" },
        },
      },
    )).toThrowError(AgentRegistrationError);
  });

  it("allows privileged registration with a valid role token", () => {
    const result = registerAgent(
      db,
      { name: "Dev", type: "test", desiredRole: "developer", authToken: "dev-secret" },
      {
        registrationAuth: {
          enabled: true,
          observerOpenRegistration: true,
          roleTokens: { developer: "dev-secret" },
        },
      },
    );

    expect(result.role).toBe("developer");
    expect(result.trustTier).toBe("A");
  });

  it("blocks observer registration when open registration is disabled", () => {
    expect(() => registerAgent(
      db,
      { name: "Obs", type: "test", desiredRole: "observer" },
      {
        registrationAuth: {
          enabled: true,
          observerOpenRegistration: false,
          roleTokens: {},
        },
      },
    )).toThrowError("Observer registration is closed");
  });

  it("allows observer registration with observer token when open registration is disabled", () => {
    const result = registerAgent(
      db,
      { name: "Obs", type: "test", desiredRole: "observer", authToken: "observer-secret" },
      {
        registrationAuth: {
          enabled: true,
          observerOpenRegistration: false,
          roleTokens: { observer: "observer-secret" },
        },
      },
    );

    expect(result.role).toBe("observer");
    expect(result.trustTier).toBe("B");
  });

  it("retrieves agent status", () => {
    const reg = registerAgent(db, { name: "Dev", type: "test", desiredRole: "developer" });
    const status = getAgentStatus(db, reg.agentId);

    expect(status).not.toBeNull();
    expect(status!.agent.name).toBe("Dev");
    expect(status!.activeSessions).toHaveLength(1);
  });

  it("returns null for unknown agents", () => {
    expect(getAgentStatus(db, "unknown-id")).toBeNull();
  });

  it("disconnects a session and releases claims", () => {
    const reg = registerAgent(db, { name: "Dev", type: "test", desiredRole: "developer" });

    // Set claims first
    sqlite.prepare(`UPDATE sessions SET claimed_files_json = ? WHERE id = ?`)
      .run(JSON.stringify(["src/a.ts"]), reg.sessionId);

    disconnectSession(db, reg.sessionId);

    const status = getAgentStatus(db, reg.agentId);
    expect(status!.activeSessions).toHaveLength(0);
    expect(status!.sessions[0]!.state).toBe("disconnected");
    expect(JSON.parse(status!.sessions[0]!.claimedFilesJson!)).toEqual([]);
  });
});
