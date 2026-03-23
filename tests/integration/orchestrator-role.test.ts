/**
 * Smoke test: orchestrator registers as facilitator and can call compute_waves.
 *
 * Covers both the FakeServer path (direct handler call) and the ToolRunner path
 * (with Zod validation) to ensure role propagation works end-to-end.
 *
 * Also verifies the facilitator role has access to all tools needed for the
 * orchestrate flow: create_work_group, compute_waves, launch_convoy, etc.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as queries from "../../src/db/queries.js";
import { registerAgentTools } from "../../src/tools/agent-tools.js";
import { registerTicketTools } from "../../src/tools/ticket-tools.js";
import { registerWorkGroupTools } from "../../src/tools/work-group-tools.js";
import { registerWaveTools } from "../../src/tools/wave-tools.js";
import { registerDecomposeTools } from "../../src/tools/decompose-tools.js";
import {
  installToolRuntimeInstrumentation,
  resetToolRateLimitState,
} from "../../src/tools/runtime-instrumentation.js";
import { getToolRunner, type ToolRunner } from "../../src/tools/tool-runner.js";
import { CoordinationBus } from "../../src/coordination/bus.js";
import { runOrchestrator, type OrchestratorCallbacks, type OrchestratorConfig } from "../../src/orchestrator/loop.js";
import { createTestDb, seedAgent } from "../fixtures/test-db.js";
import { FakeServer } from "../fixtures/fake-server.js";
import { checkToolAccess } from "../../src/trust/tiers.js";

vi.mock("../../src/git/operations.js", () => ({
  getHead: vi.fn().mockResolvedValue("abc1234"),
}));

describe("orchestrator role smoke test", () => {
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  let db: ReturnType<typeof createTestDb>["db"];
  let server: FakeServer;
  let runner: ToolRunner;
  let repoId: number;
  let bus: CoordinationBus;

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/test", "test").id;
    bus = new CoordinationBus("hub-spoke", 200, db, repoId);
    resetToolRateLimitState();

    server = new FakeServer();

    const getContext = async () => ({
      db,
      sqlite,
      repoId,
      repoPath: "/test",
      config: {
        debugLogging: false,
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
        toolRateLimits: { defaultPerMinute: 100 },
        secretPatterns: [],
      },
      insight: { info: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined },
      bus,
      searchRouter: { rebuildTicketFts: () => {}, searchTickets: () => [] },
      globalDb: null,
      globalSqlite: null,
    } as any);

    installToolRuntimeInstrumentation(server as unknown as McpServer, getContext);
    registerAgentTools(server as unknown as McpServer, getContext);
    registerTicketTools(server as unknown as McpServer, getContext);
    registerWorkGroupTools(server as unknown as McpServer, getContext);
    registerWaveTools(server as unknown as McpServer, getContext);
    registerDecomposeTools(server as unknown as McpServer, getContext);

    runner = getToolRunner(server as unknown as McpServer);
  });

  afterEach(() => {
    resetToolRateLimitState();
    sqlite.close();
    vi.clearAllMocks();
  });

  function handler(name: string) {
    const found = server.handlers.get(name);
    expect(found).toBeTypeOf("function");
    return found!;
  }

  it("orchestrator registers as facilitator and compute_waves succeeds", async () => {
    // Seed an admin agent to set up the work group
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

  // ─── ToolRunner path: validates Zod schemas like production ───

  it("ToolRunner: register_agent assigns facilitator, compute_waves succeeds", async () => {
    // Register as facilitator via ToolRunner (with Zod validation)
    const regResult = await runner.callTool("register_agent", {
      name: "orchestrator",
      desiredRole: "facilitator",
    });
    expect(regResult.ok).toBe(true);
    const regData = JSON.parse((regResult as any).result.content[0].text);
    expect(regData.role).toBe("facilitator");

    const { agentId, sessionId } = regData;

    // Create ticket + work group via facilitator (now allowed)
    const ticketResult = await runner.callTool("create_ticket", {
      title: "ToolRunner smoke ticket",
      description: "test",
      severity: "medium",
      priority: 5,
      agentId,
      sessionId,
    });
    expect(ticketResult.ok).toBe(true);
    const ticketId = JSON.parse((ticketResult as any).result.content[0].text).ticketId;

    const wgResult = await runner.callTool("create_work_group", {
      title: "ToolRunner WG",
      ticketIds: [ticketId],
      agentId,
      sessionId,
    });
    expect(wgResult.ok).toBe(true);
    const groupId = JSON.parse((wgResult as any).result.content[0].text).groupId;

    // compute_waves via ToolRunner — must NOT be denied
    const wavesResult = await runner.callTool("compute_waves", {
      groupId,
      agentId,
      sessionId,
    });
    expect(wavesResult.ok).toBe(true);
    const wavesData = JSON.parse((wavesResult as any).result.content[0].text);
    expect(wavesData.waveCount).toBeGreaterThanOrEqual(1);
  });

  it("ToolRunner: runOrchestrator registers as facilitator and reaches compute_waves", async () => {
    // Setup: create ticket + work group with a developer
    seedAgent(db, "setup-agent", "setup-session", { role: "developer" });
    const ticketResult = await runner.callTool("create_ticket", {
      title: "E2E ticket",
      description: "end-to-end test",
      severity: "medium",
      priority: 5,
      agentId: "setup-agent",
      sessionId: "setup-session",
    });
    expect(ticketResult.ok).toBe(true);
    const ticketId = JSON.parse((ticketResult as any).result.content[0].text).ticketId;

    const wgResult = await runner.callTool("create_work_group", {
      title: "E2E WG",
      ticketIds: [ticketId],
      agentId: "setup-agent",
      sessionId: "setup-session",
    });
    expect(wgResult.ok).toBe(true);
    const groupId = JSON.parse((wgResult as any).result.content[0].text).groupId;

    // Run the orchestrator loop with real ToolRunner for register_agent + compute_waves,
    // then mock from launch_convoy onward (requires git operations)
    const logs: string[] = [];
    const toolCalls: string[] = [];
    const config: OrchestratorConfig = {
      groupId,
      maxConcurrentAgents: 1,
      pollIntervalMs: 1,
      repoPath: "/test",
    };

    const callbacks: OrchestratorCallbacks = {
      callTool: async (name, params) => {
        toolCalls.push(name);
        // Use real ToolRunner for register_agent and compute_waves
        if (name === "register_agent" || name === "compute_waves") {
          const r = await runner.callTool(name, params);
          if (!r.ok) {
            throw new Error(`Tool ${name} failed: ${r.message ?? (r as any).errorCode}`);
          }
          return (r as any).result;
        }
        // Mock the rest (require git operations or spawning)
        if (name === "launch_convoy") return { content: [{ type: "text", text: JSON.stringify({ integrationBranch: "integration/WG-test" }) }] };
        if (name === "get_wave_status") return { content: [{ type: "text", text: JSON.stringify({ dispatchedTickets: [ticketId] }) }] };
        if (name === "spawn_agent") return { content: [{ type: "text", text: JSON.stringify({ worktreePath: "/tmp/wt", ticketId: (params as any).ticketId }) }] };
        if (name === "advance_wave") return { content: [{ type: "text", text: JSON.stringify({ mergedTickets: [ticketId], conflictedTickets: [], allWavesComplete: true }) }] };
        if (name === "end_session") return { content: [{ type: "text", text: JSON.stringify({ ended: true }) }] };
        return {};
      },
      spawnProcess: async (_wt, tid) => ({ pid: 9999, ticketId: tid, sessionId: `spawn-${tid}` }),
      killProcess: async () => {},
      isProcessAlive: () => false,
      log: (_level, msg) => { logs.push(msg); },
      sleep: async () => {},
    };

    // This MUST NOT throw "must be registered as facilitator or admin, but got observer"
    const result = await runOrchestrator(config, callbacks);

    // Verify registration as facilitator
    expect(logs.some(l => l.includes("role: facilitator"))).toBe(true);
    // Verify compute_waves was called via real ToolRunner
    expect(toolCalls).toContain("compute_waves");
    expect(result.totalWaves).toBeGreaterThanOrEqual(1);
    expect(result.mergedTickets).toContain(ticketId);
  });

  // ─── Role permission coverage for orchestrate flow ───

  it("facilitator role has access to all tools needed by orchestrate", () => {
    const orchestrateTools = [
      "register_agent",
      "compute_waves",
      "launch_convoy",
      "get_wave_status",
      "spawn_agent",
      "advance_wave",
      // Also needed for full orchestration setup:
      "create_work_group",
      "add_tickets_to_group",
      "decompose_goal",
      "create_ticket",
    ];

    for (const tool of orchestrateTools) {
      const access = checkToolAccess(tool, "facilitator", "A");
      expect(access.allowed, `facilitator should have access to ${tool}`).toBe(true);
    }
  });
});
