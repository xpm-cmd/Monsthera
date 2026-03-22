import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as queries from "../../../src/db/queries.js";
import { registerKnowledgeTools } from "../../../src/tools/knowledge-tools.js";
import { FakeServer } from "../../fixtures/fake-server.js";
import { createTestDb } from "../../fixtures/test-db.js";

describe("knowledge tools", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let rebuildKnowledgeFts: ReturnType<typeof vi.fn>;
  let searchKnowledge: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    rebuildKnowledgeFts = vi.fn();
    searchKnowledge = vi.fn((_sqlite, _query, _limit, _type) => {
      const rows = sqlite.prepare(`
        SELECT id, title
        FROM knowledge
        WHERE status = 'active'
        ORDER BY updated_at DESC
      `).all() as Array<{ id: number; title: string }>;
      return rows.map((row) => ({ knowledgeId: row.id, title: row.title, score: 0.8 }));
    });

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

    const repoId = queries.upsertRepo(db, "/test", "test").id;

    server = new FakeServer();
    registerKnowledgeTools(server as unknown as McpServer, async () => ({
      db,
      repoId,
      sqlite,
      globalDb: null,
      globalSqlite: null,
      searchRouter: {
        searchKnowledge,
        getSemanticReranker: () => null,
        rebuildKnowledgeFts,
      },
      insight: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
      },
    } as any));
  });

  afterEach(() => sqlite.close());

  function handler(name: string) {
    const found = server.handlers.get(name);
    expect(found).toBeTypeOf("function");
    return found!;
  }

  async function storeAsDeveloper() {
    const result = await handler("store_knowledge")({
      type: "pattern",
      scope: "repo",
      title: "Shared auth guard",
      content: "Resolve the agent and gate writes through the trust layer.",
      tags: ["auth", "pattern"],
      agentId: "agent-dev",
      sessionId: "session-agent-dev",
    });
    expect(result.isError).toBeUndefined();
    return JSON.parse(result.content[0].text);
  }

  it("stores knowledge for a validated developer actor", async () => {
    const payload = await storeAsDeveloper();
    const entry = queries.getKnowledgeByKey(db, payload.key);

    expect(entry).toMatchObject({
      key: payload.key,
      type: "pattern",
      title: "Shared auth guard",
      agentId: "agent-dev",
      sessionId: "session-agent-dev",
      status: "active",
    });
    expect(rebuildKnowledgeFts).toHaveBeenCalledTimes(1);
  });

  it("denies observer knowledge mutation", async () => {
    const result = await handler("store_knowledge")({
      type: "context",
      scope: "repo",
      title: "Observer write",
      content: "This should fail",
      tags: [],
      agentId: "agent-obs",
      sessionId: "session-agent-obs",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not have access to store_knowledge");
  });

  it("archives stored knowledge for a developer", async () => {
    const payload = await storeAsDeveloper();

    const result = await handler("archive_knowledge")({
      key: payload.key,
      scope: "repo",
      agentId: "agent-dev",
      sessionId: "session-agent-dev",
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      archived: true,
      key: payload.key,
      scope: "repo",
    });
    expect(queries.getKnowledgeByKey(db, payload.key)?.status).toBe("archived");
    expect(rebuildKnowledgeFts).toHaveBeenCalledTimes(2);
  });

  it("denies reviewer delete_knowledge even with a valid session", async () => {
    const payload = await storeAsDeveloper();

    const result = await handler("delete_knowledge")({
      key: payload.key,
      scope: "repo",
      agentId: "agent-review",
      sessionId: "session-agent-review",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not have access to delete_knowledge");
    expect(queries.getKnowledgeByKey(db, payload.key)).toBeTruthy();
  });

  it("falls back to empty tags when stored knowledge JSON is malformed", async () => {
    const payload = await storeAsDeveloper();
    sqlite.prepare("UPDATE knowledge SET tags_json = ? WHERE key = ?").run("{bad json", payload.key);

    const result = await handler("query_knowledge")({
      scope: "repo",
      status: "active",
      limit: 10,
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      count: 1,
      entries: [expect.objectContaining({ key: payload.key, tags: [] })],
    });
  });

  it("reuses backend knowledge search semantics for repo-scoped search", async () => {
    const payload = await storeAsDeveloper();

    const result = await handler("search_knowledge")({
      query: "shared auth",
      scope: "repo",
      limit: 10,
    });

    // limit + 1 for hasMore detection (user passed limit=10, tool requests 11)
    expect(searchKnowledge).toHaveBeenCalledWith(sqlite, "shared auth", 11, undefined);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      query: "shared auth",
      scope: "repo",
      count: 1,
      results: [expect.objectContaining({ key: payload.key, scope: "repo" })],
    });
  });
});
