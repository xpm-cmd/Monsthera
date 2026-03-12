import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { CoordinationBus } from "../../../src/coordination/bus.js";
import { registerCoordinationTools } from "../../../src/tools/coordination-tools.js";

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
provider TEXT,
model TEXT,
model_family TEXT,
model_version TEXT,
identity_source TEXT,
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

describe("coordination tools", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let bus: CoordinationBus;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    bus = new CoordinationBus();

    const now = new Date().toISOString();
    for (const agent of [
      { id: "agent-dev", roleId: "developer", trustTier: "A" },
      { id: "agent-review", roleId: "reviewer", trustTier: "A" },
      { id: "agent-obs", roleId: "observer", trustTier: "B" },
    ]) {
      queries.upsertAgent(db, {
        id: agent.id,
        name: agent.id,
        type: "test",
        roleId: agent.roleId as "developer" | "reviewer" | "observer",
        trustTier: agent.trustTier as "A" | "B",
        registeredAt: now,
      });
      queries.insertSession(db, {
        id: `session-${agent.id}`,
        agentId: agent.id,
        state: "active",
        connectedAt: now,
        lastActivity: now,
      });
    }

    server = new FakeServer();
    registerCoordinationTools(server as unknown as McpServer, async () => ({
      db,
      bus,
      insight: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as any));
  });

  afterEach(() => sqlite.close());

  function handler(name: string) {
    const found = server.handlers.get(name);
    expect(found).toBeTypeOf("function");
    return found!;
  }

  it("sends coordination messages for allowed roles and exposes them via poll", async () => {
    const sendResult = await handler("send_coordination")({
      type: "status_update",
      payload: { domain: "ticket", ticketId: "TKT-123" },
      to: "agent-review",
      agentId: "agent-dev",
      sessionId: "session-agent-dev",
    });

    expect(sendResult.isError).toBeUndefined();
    const pollResult = await handler("poll_coordination")({
      agentId: "agent-review",
      sessionId: "session-agent-review",
      limit: 10,
    });

    const payload = JSON.parse(pollResult.content[0].text);
    expect(payload.count).toBe(1);
    expect(payload.messages[0]).toMatchObject({
      from: "agent-dev",
      to: "agent-review",
      type: "status_update",
      payload: { domain: "ticket", ticketId: "TKT-123" },
    });
  });

  it("denies observers from sending coordination messages", async () => {
    const result = await handler("send_coordination")({
      type: "broadcast",
      payload: { note: "hi" },
      to: null,
      agentId: "agent-obs",
      sessionId: "session-agent-obs",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not have access to send_coordination");
  });

  it("requires an active session to poll coordination messages", async () => {
    const result = await handler("poll_coordination")({
      agentId: "agent-review",
      sessionId: "session-missing",
      limit: 10,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Agent or session not found / inactive");
  });
});
