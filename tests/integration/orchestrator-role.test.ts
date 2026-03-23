/**
 * Smoke test: orchestrator registers as facilitator and can call compute_waves.
 *
 * Reproduces the bug where OPEN_REGISTRATION_ROLES did not include "facilitator",
 * causing the orchestrator to silently downgrade to "observer" and fail on
 * compute_waves with "Role observer does not have access to compute_waves".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as queries from "../../src/db/queries.js";
import { registerAgentTools } from "../../src/tools/agent-tools.js";
import { registerTicketTools } from "../../src/tools/ticket-tools.js";
import { registerWorkGroupTools } from "../../src/tools/work-group-tools.js";
import { registerWaveTools } from "../../src/tools/wave-tools.js";
import { CoordinationBus } from "../../src/coordination/bus.js";
import { createTestDb, seedAgent } from "../fixtures/test-db.js";
import { FakeServer } from "../fixtures/fake-server.js";

vi.mock("../../src/git/operations.js", () => ({
  getHead: vi.fn().mockResolvedValue("abc1234"),
}));

describe("orchestrator role smoke test", () => {
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let repoId: number;
  let bus: CoordinationBus;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    bus = new CoordinationBus("hub-spoke", 200, db, repoId);

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

    registerAgentTools(server as unknown as McpServer, getContext);
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

  it("orchestrator registers as facilitator and compute_waves succeeds", async () => {
    // Seed an admin agent to set up the work group (facilitator can't create_work_group)
    seedAgent(db, "admin-setup", "session-admin", { role: "admin", trustTier: "A" });

    const now = new Date().toISOString();
    queries.insertTicket(db, {
      repoId,
      ticketId: "TKT-smoke",
      title: "Smoke test ticket",
      description: "test",
      status: "backlog",
      severity: "medium",
      priority: 5,
      creatorAgentId: "admin-setup",
      creatorSessionId: "session-admin",
      commitSha: "abc1234",
      createdAt: now,
      updatedAt: now,
    });

    const createGroupResult = await handler("create_work_group")({
      title: "Smoke group",
      description: "test",
      agentId: "admin-setup",
      sessionId: "session-admin",
    });
    expect(createGroupResult.isError).not.toBe(true);
    const groupId = JSON.parse(createGroupResult.content[0].text).groupId;

    await handler("add_tickets_to_group")({
      groupId,
      ticketIds: ["TKT-smoke"],
      agentId: "admin-setup",
      sessionId: "session-admin",
    });

    // Step 1: Register orchestrator with desiredRole "facilitator" (no auth)
    const regResult = await handler("register_agent")({
      name: "orchestrator",
      type: "unknown",
      desiredRole: "facilitator",
    });

    expect(regResult.isError).not.toBe(true);
    const regPayload = JSON.parse(regResult.content[0].text);

    // The fix: facilitator must NOT be downgraded to observer
    expect(regPayload.role).toBe("facilitator");
    expect(regPayload.trustTier).toBe("A");

    const { agentId, sessionId } = regPayload;

    // Step 2: compute_waves — this used to fail with
    // "Role observer does not have access to compute_waves"
    const waveResult = await handler("compute_waves")({
      groupId,
      agentId,
      sessionId,
    });

    expect(waveResult.isError).not.toBe(true);
    const wavePlan = JSON.parse(waveResult.content[0].text);
    expect(wavePlan.waveCount).toBeGreaterThanOrEqual(1);
    expect(wavePlan.waves[0].tickets).toContain("TKT-smoke");
  });

  it("orchestrator facilitator role persists in DB for subsequent tool calls", async () => {
    // Register as facilitator
    const regResult = await handler("register_agent")({
      name: "orchestrator",
      type: "unknown",
      desiredRole: "facilitator",
    });
    const { agentId } = JSON.parse(regResult.content[0].text);

    // Verify the DB has the correct role (not the column default "observer")
    const agent = queries.getAgent(db, agentId);
    expect(agent).toBeTruthy();
    expect(agent!.roleId).toBe("facilitator");
    expect(agent!.trustTier).toBe("A");
  });

  it("re-registration (resume) preserves facilitator role", async () => {
    // First registration
    const reg1 = await handler("register_agent")({
      name: "orchestrator",
      type: "unknown",
      desiredRole: "facilitator",
    });
    const { agentId: id1 } = JSON.parse(reg1.content[0].text);

    // End the session so the agent can be resumed
    const sessions1 = queries.getAllSessions(db).filter(s => s.agentId === id1);
    for (const s of sessions1) {
      await handler("end_session")({ agentId: id1, sessionId: s.id });
    }

    // Second registration — should resume and keep facilitator
    const reg2 = await handler("register_agent")({
      name: "orchestrator",
      type: "unknown",
      desiredRole: "facilitator",
    });
    const reg2Payload = JSON.parse(reg2.content[0].text);

    expect(reg2Payload.role).toBe("facilitator");
    expect(reg2Payload.resumed).toBe(true);

    // Verify DB
    const agent = queries.getAgent(db, reg2Payload.agentId);
    expect(agent!.roleId).toBe("facilitator");
  });
});
