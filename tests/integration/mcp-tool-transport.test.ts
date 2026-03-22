import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as queries from "../../src/db/queries.js";
import { registerAgentTools } from "../../src/tools/agent-tools.js";
import { registerTicketTools } from "../../src/tools/ticket-tools.js";
import { registerKnowledgeTools } from "../../src/tools/knowledge-tools.js";
import { CoordinationBus } from "../../src/coordination/bus.js";
import { createTestDb, seedAgent } from "../fixtures/test-db.js";
import { FakeServer } from "../fixtures/fake-server.js";

vi.mock("../../src/git/operations.js", () => ({
  getHead: vi.fn().mockResolvedValue("abc1234"),
}));

describe("cross-domain MCP tool transport", () => {
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let repoId: number;
  let bus: CoordinationBus;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    bus = new CoordinationBus("hub-spoke", 200, db, repoId);

    seedAgent(db, "agent-dev", "session-dev", { role: "developer", trustTier: "A" });

    server = new FakeServer();

    const getContext = async () => ({
      db,
      sqlite,
      repoId,
      repoPath: "/test",
      config: {
        registrationAuth: { enabled: false, observerOpenRegistration: true, roleTokens: {} },
        claimEnforceMode: "advisory",
        governance: {
          nonVotingRoles: ["facilitator"],
          modelDiversity: { strict: false, maxVotersPerModel: 10 },
          reviewerIndependence: { strict: false, identityKey: "agent" },
          backlogPlanningGate: { enforce: false, minIterations: 1, requiredDistinctModels: 1 },
          requireBinding: false,
          autoAdvance: false,
          autoAdvanceExcludedTags: [],
        },
        ticketQuorum: { enabled: false, requiredPasses: 1, vetoSpecializations: [] },
      },
      insight: { info: () => undefined, warn: () => undefined, debug: () => undefined },
      bus,
      searchRouter: {
        rebuildTicketFts: () => {},
        searchTickets: () => [],
        rebuildKnowledgeFts: (targetSqlite: unknown) => {
          const s = targetSqlite as any;
          s.prepare("DELETE FROM knowledge_fts").run();
          const rows = s.prepare(
            "SELECT id, title, content, type, tags_json FROM knowledge WHERE status = 'active'",
          ).all();
          const ins = s.prepare(
            "INSERT INTO knowledge_fts(knowledge_id, title, content, type, tags) VALUES (?, ?, ?, ?, ?)",
          );
          for (const row of rows as any[]) {
            ins.run(row.id, row.title, row.content, row.type, row.tags_json ?? "");
          }
        },
        getSemanticReranker: () => null,
        searchKnowledge: (targetSqlite: unknown, query: string, limit?: number) => {
          const stmt = (targetSqlite as any).prepare(
            "SELECT knowledge_id, rank FROM knowledge_fts WHERE knowledge_fts MATCH ? ORDER BY rank LIMIT ?",
          );
          try {
            const rows = stmt.all(query.split(/\s+/).join(" OR "), limit ?? 10);
            return rows.map((r: any) => ({ knowledgeId: Number(r.knowledge_id), score: -r.rank }));
          } catch {
            return [];
          }
        },
      },
      globalDb: null,
      globalSqlite: null,
    } as any);

    registerAgentTools(server as unknown as McpServer, getContext);
    registerTicketTools(server as unknown as McpServer, getContext);
    registerKnowledgeTools(server as unknown as McpServer, getContext);
  });

  afterEach(() => {
    sqlite.close();
    vi.clearAllMocks();
  });

  function handler(name: string) {
    const found = server.handlers.get(name);
    expect(found).toBeTypeOf("function");
    return found!;
  }

  it("registers agent and retrieves status across tool domains", async () => {
    const registerResult = await handler("register_agent")({
      name: "TestAgent",
      type: "test",
      desiredRole: "developer",
    });
    const registerData = JSON.parse(registerResult.content[0].text);
    const { agentId, sessionId } = registerData;

    expect(agentId).toBeDefined();
    expect(sessionId).toBeDefined();

    const statusResult = await handler("agent_status")({
      agentId,
    });
    const statusData = JSON.parse(statusResult.content[0].text);

    expect(statusData.agent.name).toBe("TestAgent");
    expect(statusData.agent.roleId).toBe("developer");
  });

  it("creates ticket and verifies via list in same context", async () => {
    const createResult = await handler("create_ticket")({
      title: "Test ticket",
      description: "A test",
      severity: "medium",
      priority: 5,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    const createData = JSON.parse(createResult.content[0].text);
    const { ticketId } = createData;

    expect(ticketId).toBeDefined();

    const listResult = await handler("list_tickets")({
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    const listData = JSON.parse(listResult.content[0].text);

    expect(
      listData.tickets.some((t: { ticketId: string }) => t.ticketId === ticketId),
    ).toBe(true);
  });

  it("stores and searches knowledge in same context", async () => {
    const storeResult = await handler("store_knowledge")({
      type: "context",
      scope: "repo",
      title: "Auth system overview",
      content: "The auth system uses JWT tokens with refresh rotation",
      tags: ["auth", "jwt"],
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    const storeData = JSON.parse(storeResult.content[0].text);

    expect(storeData.key).toBeDefined();
    expect(storeData.title).toBe("Auth system overview");

    const searchResult = await handler("search_knowledge")({
      query: "JWT auth",
    });
    const searchData = JSON.parse(searchResult.content[0].text);

    expect(searchData.results.length).toBeGreaterThanOrEqual(1);
    expect(
      searchData.results.some(
        (r: { title: string }) => r.title === "Auth system overview",
      ),
    ).toBe(true);
  });

  it("cross-domain consistency: ticket creator matches agent", async () => {
    const createResult = await handler("create_ticket")({
      title: "Cross-domain ticket",
      description: "Verify creator agent linkage",
      severity: "low",
      priority: 3,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    const createData = JSON.parse(createResult.content[0].text);
    const { ticketId } = createData;

    expect(ticketId).toBeDefined();

    // Use get_ticket to verify creator agent linkage across domains
    const ticketDetail = await handler("get_ticket")({
      ticketId,
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    const ticketData = JSON.parse(ticketDetail.content[0].text);
    expect(ticketData.creatorAgentId).toBe("agent-dev");

    // Verify the creator agent exists via agent_status (cross-domain check)
    const statusResult = await handler("agent_status")({
      agentId: "agent-dev",
    });
    const statusData = JSON.parse(statusResult.content[0].text);

    expect(statusData.agent.name).toBe("agent-dev");
    expect(statusData.agent.roleId).toBe("developer");
  });
});
