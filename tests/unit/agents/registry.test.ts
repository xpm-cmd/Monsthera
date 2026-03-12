import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { AgentRegistrationError, registerAgent, getAgentStatus, disconnectSession, reapStaleSessions } from "../../../src/agents/registry.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  for (const stmt of [
    `CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', provider TEXT, model TEXT, model_family TEXT, model_version TEXT, identity_source TEXT, role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL)`,
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
    expect(result.identity).toEqual({
      provider: null,
      model: null,
      modelFamily: null,
      modelVersion: null,
      identitySource: null,
    });
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
    const reg = registerAgent(db, {
      name: "Dev",
      type: "test",
      provider: "openai",
      model: "gpt-5",
      modelFamily: "gpt-5",
      modelVersion: "2026-03",
      desiredRole: "developer",
    });
    const status = getAgentStatus(db, reg.agentId);

    expect(status).not.toBeNull();
    expect(status!.agent.name).toBe("Dev");
    expect(status!.agent.provider).toBe("openai");
    expect(status!.agent.model).toBe("gpt-5");
    expect(status!.agent.identitySource).toBe("self_declared");
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

  it("rolls back agent registration when session insert fails", () => {
    sqlite.exec(`
      CREATE TRIGGER fail_session_insert
      BEFORE INSERT ON sessions
      BEGIN
        SELECT RAISE(FAIL, 'session insert failed');
      END;
    `);

    expect(() => registerAgent(
      db,
      { name: "Dev", type: "test", desiredRole: "developer" },
    )).toThrowError("session insert failed");

    const agentCount = sqlite.prepare("SELECT COUNT(*) as count FROM agents").get() as { count: number };
    const sessionCount = sqlite.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number };
    expect(agentCount.count).toBe(0);
    expect(sessionCount.count).toBe(0);
  });

  it("reaps sessions with corrupted lastActivity (NaN date)", () => {
    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("agent-nan", "BadDate", "test", "developer", "A", new Date().toISOString());
    sqlite.prepare(`
      INSERT INTO sessions (id, agent_id, state, connected_at, last_activity)
      VALUES (?, ?, ?, ?, ?)
    `).run("session-nan", "agent-nan", "active", new Date().toISOString(), "not-a-date");

    const reaped = reapStaleSessions(db);
    expect(reaped).toBe(1);

    const session = sqlite.prepare("SELECT state FROM sessions WHERE id = ?").get("session-nan") as { state: string };
    expect(session.state).toBe("disconnected");
  });

  it("registers a facilitator with Tier A", () => {
    const result = registerAgent(db, { name: "Facilitator", type: "claude-code", desiredRole: "facilitator" });
    expect(result.role).toBe("facilitator");
    expect(result.trustTier).toBe("A");
  });

  it("allows facilitator registration with a valid role token", () => {
    const result = registerAgent(
      db,
      { name: "Facilitator", type: "test", desiredRole: "facilitator", authToken: "fac-secret" },
      {
        registrationAuth: {
          enabled: true,
          observerOpenRegistration: true,
          roleTokens: { facilitator: "fac-secret" },
        },
      },
    );
    expect(result.role).toBe("facilitator");
    expect(result.trustTier).toBe("A");
  });

  it("rolls back stale-session reaping when claim cleanup fails", () => {
    const now = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("agent-1", "Dev", "test", "developer", "A", now);
    sqlite.prepare(`
      INSERT INTO sessions (id, agent_id, state, connected_at, last_activity, claimed_files_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("session-1", "agent-1", "active", now, now, JSON.stringify(["src/file.ts"]));

    sqlite.exec(`
      CREATE TRIGGER fail_claim_clear
      BEFORE UPDATE OF claimed_files_json ON sessions
      BEGIN
        SELECT RAISE(FAIL, 'claim clear failed');
      END;
    `);

    expect(() => reapStaleSessions(db)).toThrowError("claim clear failed");

    const session = sqlite.prepare("SELECT state, claimed_files_json as claimedFilesJson FROM sessions WHERE id = ?")
      .get("session-1") as { state: string; claimedFilesJson: string | null };
    expect(session.state).toBe("active");
    expect(JSON.parse(session.claimedFilesJson ?? "[]")).toEqual(["src/file.ts"]);
  });
});
