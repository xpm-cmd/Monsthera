import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as queries from "../../src/db/queries.js";
import { registerTicketTools } from "../../src/tools/ticket-tools.js";
import { registerWorkGroupTools } from "../../src/tools/work-group-tools.js";
import { registerWaveTools } from "../../src/tools/wave-tools.js";
import { CoordinationBus } from "../../src/coordination/bus.js";
import { createTestDb, seedAgent } from "../fixtures/test-db.js";
import { FakeServer } from "../fixtures/fake-server.js";

vi.mock("../../src/git/operations.js", () => ({
  getHead: vi.fn().mockResolvedValue("abc1234"),
}));

describe("wave orchestration", () => {
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let repoId: number;
  let bus: CoordinationBus;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    bus = new CoordinationBus("hub-spoke", 200, db, repoId);

    seedAgent(db, "agent-fac", "session-fac", { role: "admin", trustTier: "A" });

    server = new FakeServer();

    const getContext = async () => ({
      db,
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
        convoy: { maxTicketsPerWave: 5, autoRefresh: true },
      },
      insight: { info: () => undefined, warn: () => undefined, debug: () => undefined },
      bus,
      searchRouter: { rebuildTicketFts: () => {}, searchTickets: () => [] },
    } as any);

    registerTicketTools(server as unknown as McpServer, getContext);
    registerWorkGroupTools(server as unknown as McpServer, getContext);
    registerWaveTools(server as unknown as McpServer, getContext);
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

  it("computes waves respecting dependency edges", async () => {
    const now = new Date().toISOString();

    // Create 4 tickets directly in DB
    for (const [ticketId, title] of [
      ["T-001", "Setup DB"],
      ["T-002", "Add API"],
      ["T-003", "Add Auth"],
      ["T-004", "Add Docs"],
    ] as const) {
      queries.insertTicket(db, {
        repoId,
        ticketId,
        title,
        description: "test",
        status: "backlog",
        severity: "medium",
        priority: 5,
        creatorAgentId: "agent-fac",
        creatorSessionId: "session-fac",
        commitSha: "abc1234",
        createdAt: now,
        updatedAt: now,
      });
    }

    // Get internal IDs and add dependency edges
    const t1 = queries.getTicketByTicketId(db, "T-001")!;
    const t2 = queries.getTicketByTicketId(db, "T-002")!;
    const t3 = queries.getTicketByTicketId(db, "T-003")!;
    const t4 = queries.getTicketByTicketId(db, "T-004")!;

    // T-001 blocks T-002
    queries.createTicketDependency(db, {
      fromTicketId: t1.id,
      toTicketId: t2.id,
      relationType: "blocks",
      createdByAgentId: "agent-fac",
      createdAt: now,
    });

    // T-001 blocks T-003
    queries.createTicketDependency(db, {
      fromTicketId: t1.id,
      toTicketId: t3.id,
      relationType: "blocks",
      createdByAgentId: "agent-fac",
      createdAt: now,
    });

    // Create work group via tool handler
    const createResult = await handler("create_work_group")({
      title: "Test wave",
      description: "test",
      agentId: "agent-fac",
      sessionId: "session-fac",
    });
    expect(createResult.isError).not.toBe(true);
    const groupId = JSON.parse(createResult.content[0].text).groupId;

    // Add all 4 tickets to the work group
    await handler("add_tickets_to_group")({
      groupId,
      ticketIds: ["T-001", "T-002", "T-003", "T-004"],
      agentId: "agent-fac",
      sessionId: "session-fac",
    });

    // Compute waves
    const waveResult = await handler("compute_waves")({
      groupId,
      agentId: "agent-fac",
      sessionId: "session-fac",
    });
    const wavePlan = JSON.parse(waveResult.content[0].text);

    // Assertions
    expect(wavePlan.waveCount).toBe(2);

    // Wave 0: T-001 and T-004 (no blockers)
    const wave0Ids = wavePlan.waves[0].tickets;
    expect(wave0Ids).toContain("T-001");
    expect(wave0Ids).toContain("T-004");
    expect(wave0Ids).toHaveLength(2);

    // Wave 1: T-002 and T-003 (blocked by T-001)
    const wave1Ids = wavePlan.waves[1].tickets;
    expect(wave1Ids).toContain("T-002");
    expect(wave1Ids).toContain("T-003");
    expect(wave1Ids).toHaveLength(2);
  });
});
