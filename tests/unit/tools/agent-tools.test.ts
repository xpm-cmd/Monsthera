import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { registerAgentTools } from "../../../src/tools/agent-tools.js";

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
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'unknown',
      role_id TEXT NOT NULL DEFAULT 'observer',
      trust_tier TEXT NOT NULL DEFAULT 'B',
      registered_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      state TEXT NOT NULL DEFAULT 'active',
      connected_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      claimed_files_json TEXT
    );
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("agent tools", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
  });

  afterEach(() => sqlite.close());

  function setupServer(registrationAuth?: {
    enabled?: boolean;
    observerOpenRegistration?: boolean;
    roleTokens?: Record<string, string>;
  }) {
    const server = new FakeServer();
    registerAgentTools(server as unknown as McpServer, async () => ({
      db,
      config: {
        registrationAuth: {
          enabled: false,
          observerOpenRegistration: true,
          roleTokens: {},
          ...registrationAuth,
        },
      },
      insight: {
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as any));
    return server.handlers.get("register_agent")!;
  }

  function insertAgentWithSession(
    agentId: string,
    sessionId: string,
    roleId: "developer" | "reviewer" | "facilitator" | "observer" | "admin",
  ) {
    const now = new Date().toISOString();
    queries.upsertAgent(db, {
      id: agentId,
      name: agentId,
      type: "test",
      roleId,
      trustTier: roleId === "observer" ? "B" : "A",
      registeredAt: now,
    });
    queries.insertSession(db, {
      id: sessionId,
      agentId,
      state: "active",
      connectedAt: now,
      lastActivity: now,
    });
  }

  function setupActionServer() {
    const server = new FakeServer();
    const insight = {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    };
    registerAgentTools(server as unknown as McpServer, async () => ({
      db,
      config: {
        registrationAuth: {
          enabled: false,
          observerOpenRegistration: true,
          roleTokens: {},
        },
      },
      insight,
    } as any));
    return { handlers: server.handlers, insight };
  }

  it("keeps open registration behavior when registrationAuth is disabled", async () => {
    const registerAgent = setupServer();
    const result = await registerAgent({
      name: "Dev",
      type: "claude-code",
      desiredRole: "developer",
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.role).toBe("developer");
    expect(payload.trustTier).toBe("A");
  });

  it("rejects privileged registration without a matching auth token", async () => {
    const registerAgent = setupServer({
      enabled: true,
      observerOpenRegistration: true,
      roleTokens: { developer: "dev-secret" },
    });

    const result = await registerAgent({
      name: "Dev",
      type: "claude-code",
      desiredRole: "developer",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid authToken for role developer");
  });

  it("allows privileged registration with a matching auth token", async () => {
    const registerAgent = setupServer({
      enabled: true,
      observerOpenRegistration: true,
      roleTokens: { reviewer: "review-secret" },
    });

    const result = await registerAgent({
      name: "Reviewer",
      type: "codex",
      desiredRole: "reviewer",
      authToken: "review-secret",
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.role).toBe("reviewer");
    expect(payload.trustTier).toBe("A");
  });

  it("allows facilitator registration when the role is requested explicitly", async () => {
    const registerAgent = setupServer();

    const result = await registerAgent({
      name: "Facilitator",
      type: "codex",
      desiredRole: "facilitator",
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.role).toBe("facilitator");
    expect(payload.trustTier).toBe("A");
  });

  it("requires a facilitator token when privileged registration is gated", async () => {
    const registerAgent = setupServer({
      enabled: true,
      observerOpenRegistration: true,
      roleTokens: { facilitator: "fac-secret" },
    });

    const denied = await registerAgent({
      name: "Facilitator",
      desiredRole: "facilitator",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("Invalid authToken for role facilitator");

    const allowed = await registerAgent({
      name: "Facilitator",
      desiredRole: "facilitator",
      authToken: "fac-secret",
    });
    expect(allowed.isError).toBeUndefined();
    const payload = JSON.parse(allowed.content[0].text);
    expect(payload.role).toBe("facilitator");
    expect(payload.trustTier).toBe("A");
  });

  it("requires an observer token when observer open registration is disabled", async () => {
    const registerAgent = setupServer({
      enabled: true,
      observerOpenRegistration: false,
      roleTokens: { observer: "observer-secret" },
    });

    const denied = await registerAgent({
      name: "Observer",
      desiredRole: "observer",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("Observer registration is closed");

    const allowed = await registerAgent({
      name: "Observer",
      desiredRole: "observer",
      authToken: "observer-secret",
    });
    expect(allowed.isError).toBeUndefined();
    const payload = JSON.parse(allowed.content[0].text);
    expect(payload.role).toBe("observer");
  });

  it("denies observer broadcast and allows reviewer broadcast with a validated session", async () => {
    insertAgentWithSession("agent-review", "session-review", "reviewer");
    insertAgentWithSession("agent-obs", "session-obs", "observer");
    const { handlers, insight } = setupActionServer();

    const denied = await handlers.get("broadcast")!({
      message: "Heads up",
      agentId: "agent-obs",
      sessionId: "session-obs",
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain("does not have access to broadcast");

    const allowed = await handlers.get("broadcast")!({
      message: "Heads up",
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(allowed.isError).toBeUndefined();
    expect(JSON.parse(allowed.content[0].text)).toMatchObject({
      broadcasted: true,
      sender: "agent-review",
      message: "Heads up",
    });
    expect(insight.info).toHaveBeenCalled();
  });

  it("stores claims on the caller session and reports conflicting claims", async () => {
    insertAgentWithSession("agent-dev", "session-dev", "developer");
    insertAgentWithSession("agent-peer", "session-peer", "developer");
    queries.updateSessionClaims(db, "session-peer", ["src/conflict.ts"]);
    const { handlers } = setupActionServer();

    const result = await handlers.get("claim_files")!({
      agentId: "agent-dev",
      sessionId: "session-dev",
      paths: ["src/conflict.ts", "src/owned.ts"],
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.claimed).toEqual(["src/conflict.ts", "src/owned.ts"]);
    expect(payload.conflicts).toEqual([{ path: "src/conflict.ts", claimedBy: "agent-peer" }]);

    const session = queries.getSession(db, "session-dev");
    expect(JSON.parse(session?.claimedFilesJson ?? "[]")).toEqual(["src/conflict.ts", "src/owned.ts"]);
  });

  it("rejects claim_files when the session does not belong to the caller", async () => {
    insertAgentWithSession("agent-dev", "session-dev", "developer");
    insertAgentWithSession("agent-peer", "session-peer", "developer");
    const { handlers } = setupActionServer();

    const result = await handlers.get("claim_files")!({
      agentId: "agent-dev",
      sessionId: "session-peer",
      paths: ["src/file.ts"],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Agent or session not found / inactive");
  });

  it("ignores malformed stored claim JSON when checking conflicts", async () => {
    insertAgentWithSession("agent-dev", "session-dev", "developer");
    insertAgentWithSession("agent-peer", "session-peer", "developer");
    sqlite.prepare("UPDATE sessions SET claimed_files_json = ? WHERE id = ?").run("{bad json", "session-peer");
    const { handlers } = setupActionServer();

    const result = await handlers.get("claim_files")!({
      agentId: "agent-dev",
      sessionId: "session-dev",
      paths: ["src/owned.ts"],
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      claimed: ["src/owned.ts"],
      conflicts: [],
    });
  });

  it("ends only the caller-owned session and clears its claims", async () => {
    insertAgentWithSession("agent-dev", "session-dev", "developer");
    queries.updateSessionClaims(db, "session-dev", ["src/file.ts"]);
    const { handlers } = setupActionServer();

    const denied = await handlers.get("end_session")!({
      agentId: "agent-other",
      sessionId: "session-dev",
    });
    expect(denied.isError).toBe(true);

    const ended = await handlers.get("end_session")!({
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    expect(ended.isError).toBeUndefined();
    expect(JSON.parse(ended.content[0].text)).toMatchObject({
      ended: true,
      sessionId: "session-dev",
      agentId: "agent-dev",
    });

    const session = queries.getSession(db, "session-dev");
    expect(session?.state).toBe("disconnected");
    expect(JSON.parse(session?.claimedFilesJson ?? "[]")).toEqual([]);
  });
});
