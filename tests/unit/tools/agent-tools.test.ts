import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
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
});
