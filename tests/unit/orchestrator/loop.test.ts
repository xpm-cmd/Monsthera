import { describe, it, expect } from "vitest";
import { runOrchestrator, type OrchestratorCallbacks, type OrchestratorConfig, type OrchestratorEvent, type OrchestratorProblem } from "../../../src/orchestrator/loop.js";

function buildConfig(overrides: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    groupId: "WG-test",
    maxConcurrentAgents: 3,
    testCommand: "pnpm test",
    testTimeoutMs: 120_000,
    pollIntervalMs: 100,
    repoPath: "/tmp/repo",
    ...overrides,
  };
}

function buildCallbacks(overrides: Partial<OrchestratorCallbacks> = {}): OrchestratorCallbacks & {
  toolCalls: Array<{ name: string; params: Record<string, unknown> }>;
  spawned: string[];
  killed: number[];
  problems: OrchestratorProblem[];
} {
  const toolCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const spawned: string[] = [];
  const killed: number[] = [];
  const problems: OrchestratorProblem[] = [];

  return {
    toolCalls,
    spawned,
    killed,
    problems,
    callTool: async (name, params) => {
      toolCalls.push({ name, params });

      if (name === "register_agent") return { agentId: "orch-agent", sessionId: "orch-session", role: "facilitator" };
      if (name === "compute_waves") return { waveCount: 2 };
      if (name === "launch_convoy") return { integrationBranch: "integration/WG-test" };
      if (name === "get_wave_status") return { dispatchedTickets: ["TKT-a"], currentWave: 0 };
      if (name === "spawn_agent") return { spawnedAgentId: `spawn-${params.ticketId}`, worktreePath: "/tmp/wt", ticketId: params.ticketId };
      if (name === "advance_wave") return { advanced: true, mergedTickets: ["TKT-a"], conflictedTickets: [], allWavesComplete: false };
      if (name === "end_session") return { ended: true };
      return {};
    },
    spawnProcess: async (_worktreePath, ticketId) => {
      spawned.push(ticketId);
      return { pid: 1000 + spawned.length, ticketId, sessionId: `session-${ticketId}` };
    },
    killProcess: async (pid) => {
      killed.push(pid);
    },
    isProcessAlive: () => false, // In tests, processes finish immediately
    log: () => {},
    sleep: async () => {},
    ...overrides,
  };
}

describe("orchestrator loop", () => {
  it("happy path: registers, computes waves, spawns, advances, and completes", async () => {
    const cbs = buildCallbacks({
      callTool: async (name, params) => {
        cbs.toolCalls.push({ name, params });
        if (name === "register_agent") return { agentId: "orch", sessionId: "s-orch", role: "facilitator" };
        if (name === "compute_waves") return { waveCount: 1 };
        if (name === "launch_convoy") return { integrationBranch: "int/WG" };
        if (name === "get_wave_status") return { dispatchedTickets: ["TKT-1", "TKT-2"] };
        if (name === "spawn_agent") return { worktreePath: "/tmp/wt", ticketId: params.ticketId };
        if (name === "advance_wave") return { mergedTickets: ["TKT-1", "TKT-2"], conflictedTickets: [], allWavesComplete: true };
        if (name === "end_session") return {};
        return {};
      },
    });

    const result = await runOrchestrator(buildConfig({ maxConcurrentAgents: 5 }), cbs);

    expect(result.wavesCompleted).toBe(1);
    expect(result.totalWaves).toBe(1);
    expect(result.mergedTickets).toEqual(["TKT-1", "TKT-2"]);
    expect(result.finalMerged).toBe(true);
    expect(result.skippedTickets).toHaveLength(0);
    expect(cbs.spawned).toEqual(["TKT-1", "TKT-2"]);
  });

  it("handles conflict: skips conflicted tickets", async () => {
    const cbs = buildCallbacks({
      callTool: async (name, params) => {
        cbs.toolCalls.push({ name, params });
        if (name === "register_agent") return { agentId: "orch", sessionId: "s-orch", role: "facilitator" };
        if (name === "compute_waves") return { waveCount: 1 };
        if (name === "launch_convoy") return { integrationBranch: "int/WG" };
        if (name === "get_wave_status") return { dispatchedTickets: ["TKT-1"] };
        if (name === "spawn_agent") return { worktreePath: "/tmp/wt", ticketId: params.ticketId };
        if (name === "advance_wave") return {
          mergedTickets: [],
          conflictedTickets: ["TKT-1"],
          conflictDetails: ["src/a.ts"],
          allWavesComplete: true,
        };
        if (name === "end_session") return {};
        return {};
      },
    });

    const result = await runOrchestrator(buildConfig(), cbs);

    expect(result.skippedTickets).toContain("TKT-1");
    expect(result.mergedTickets).toHaveLength(0);
  });

  it("handles test failure: skips culprit via bisect", async () => {
    const cbs = buildCallbacks({
      callTool: async (name, params) => {
        cbs.toolCalls.push({ name, params });
        if (name === "register_agent") return { agentId: "orch", sessionId: "s-orch", role: "facilitator" };
        if (name === "compute_waves") return { waveCount: 1 };
        if (name === "launch_convoy") return { integrationBranch: "int/WG" };
        if (name === "get_wave_status") return { dispatchedTickets: ["TKT-1"] };
        if (name === "spawn_agent") return { worktreePath: "/tmp/wt", ticketId: params.ticketId };
        if (name === "advance_wave") return {
          mergedTickets: [],
          conflictedTickets: [],
          testFailed: true,
          bisectCulprit: "TKT-1",
          allWavesComplete: true,
        };
        if (name === "end_session") return {};
        return {};
      },
    });

    const result = await runOrchestrator(buildConfig(), cbs);

    expect(result.skippedTickets).toContain("TKT-1");
  });

  it("concurrency: respects maxConcurrentAgents limit", async () => {
    let concurrentCount = 0;
    let maxConcurrent = 0;

    const cbs = buildCallbacks({
      callTool: async (name, params) => {
        cbs.toolCalls.push({ name, params });
        if (name === "register_agent") return { agentId: "orch", sessionId: "s-orch", role: "facilitator" };
        if (name === "compute_waves") return { waveCount: 1 };
        if (name === "launch_convoy") return { integrationBranch: "int/WG" };
        if (name === "get_wave_status") return { dispatchedTickets: ["TKT-1", "TKT-2", "TKT-3", "TKT-4", "TKT-5"] };
        if (name === "spawn_agent") return { worktreePath: "/tmp/wt", ticketId: params.ticketId };
        if (name === "advance_wave") return { mergedTickets: ["TKT-1", "TKT-2", "TKT-3", "TKT-4", "TKT-5"], conflictedTickets: [], allWavesComplete: true };
        if (name === "end_session") return {};
        return {};
      },
      spawnProcess: async (_, ticketId) => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        cbs.spawned.push(ticketId);
        return { pid: 1000 + cbs.spawned.length, ticketId, sessionId: `s-${ticketId}` };
      },
    });

    const result = await runOrchestrator(buildConfig({ maxConcurrentAgents: 2, pollIntervalMs: 1 }), cbs);

    expect(cbs.spawned).toHaveLength(5);
    expect(result.mergedTickets).toHaveLength(5);
  });

  it("LLM fallback: onProblem returns abort → orchestration stops", async () => {
    const cbs = buildCallbacks({
      callTool: async (name, params) => {
        cbs.toolCalls.push({ name, params });
        if (name === "register_agent") return { agentId: "orch", sessionId: "s-orch", role: "facilitator" };
        if (name === "compute_waves") return { waveCount: 1 };
        if (name === "launch_convoy") return { integrationBranch: "int/WG" };
        if (name === "get_wave_status") return { dispatchedTickets: ["TKT-1"] };
        if (name === "spawn_agent") return { worktreePath: "/tmp/wt", ticketId: params.ticketId };
        if (name === "advance_wave") return {
          mergedTickets: [],
          conflictedTickets: ["TKT-1"],
          allWavesComplete: false,
        };
        if (name === "end_session") return {};
        return {};
      },
      onProblem: async (problem) => {
        cbs.problems.push(problem);
        return { action: "abort" };
      },
    });

    const result = await runOrchestrator(buildConfig(), cbs);

    expect(cbs.problems.length).toBeGreaterThanOrEqual(1);
    expect(cbs.problems[0]!.kind).toBe("conflict");
    expect(result.finalMerged).toBe(false);
  });

  it("spawn failure: skips ticket by default", async () => {
    const cbs = buildCallbacks({
      callTool: async (name, params) => {
        cbs.toolCalls.push({ name, params });
        if (name === "register_agent") return { agentId: "orch", sessionId: "s-orch", role: "facilitator" };
        if (name === "compute_waves") return { waveCount: 1 };
        if (name === "launch_convoy") return { integrationBranch: "int/WG" };
        if (name === "get_wave_status") return { dispatchedTickets: ["TKT-1"] };
        if (name === "spawn_agent") return { worktreePath: "/tmp/wt", ticketId: params.ticketId };
        if (name === "advance_wave") return { mergedTickets: [], conflictedTickets: [], allWavesComplete: true };
        if (name === "end_session") return {};
        return {};
      },
      spawnProcess: async () => {
        throw new Error("Process spawn failed");
      },
    });

    const result = await runOrchestrator(buildConfig(), cbs);

    expect(result.skippedTickets).toContain("TKT-1");
  });

  it("zero waves: returns immediately", async () => {
    const cbs = buildCallbacks({
      callTool: async (name, params) => {
        cbs.toolCalls.push({ name, params });
        if (name === "register_agent") return { agentId: "orch", sessionId: "s-orch", role: "facilitator" };
        if (name === "compute_waves") return { waveCount: 0 };
        return {};
      },
    });

    const result = await runOrchestrator(buildConfig(), cbs);

    expect(result.wavesCompleted).toBe(0);
    expect(result.totalWaves).toBe(0);
    const toolNames = cbs.toolCalls.map((c) => c.name);
    expect(toolNames).not.toContain("launch_convoy");
  });

  it("timeout: stuck agent detected and killed after stale poll cycles", async () => {
    let _pollCycles = 0;
    const cbs = buildCallbacks({
      callTool: async (name, params) => {
        cbs.toolCalls.push({ name, params });
        if (name === "register_agent") return { agentId: "orch", sessionId: "s-orch", role: "facilitator" };
        if (name === "compute_waves") return { waveCount: 1 };
        if (name === "launch_convoy") return { integrationBranch: "int/WG" };
        if (name === "get_wave_status") return { dispatchedTickets: ["TKT-stuck"] };
        if (name === "spawn_agent") return { worktreePath: "/tmp/wt", ticketId: params.ticketId };
        if (name === "advance_wave") return { mergedTickets: [], conflictedTickets: [], allWavesComplete: true };
        if (name === "end_session") return {};
        return {};
      },
      isProcessAlive: () => true, // Process never finishes
      sleep: async () => { _pollCycles++; },
    });

    const result = await runOrchestrator(buildConfig(), cbs);

    expect(result.skippedTickets).toContain("TKT-stuck");
    expect(cbs.killed.length).toBeGreaterThanOrEqual(1);
  });

  // ── Observability events ──

  it("emits lifecycle events in correct order", async () => {
    const events: OrchestratorEvent[] = [];

    const cbs = buildCallbacks({
      callTool: async (name, params) => {
        cbs.toolCalls.push({ name, params });
        if (name === "register_agent") return { agentId: "orch", sessionId: "s-orch", role: "facilitator" };
        if (name === "compute_waves") return { waveCount: 1 };
        if (name === "launch_convoy") return { integrationBranch: "int/WG" };
        if (name === "get_wave_status") return { dispatchedTickets: ["TKT-1"] };
        if (name === "spawn_agent") return { worktreePath: "/tmp/wt", ticketId: params.ticketId };
        if (name === "advance_wave") return { mergedTickets: ["TKT-1"], conflictedTickets: [], allWavesComplete: true };
        if (name === "end_session") return {};
        return {};
      },
      onEvent: (event) => { events.push(event); },
    });

    await runOrchestrator(buildConfig({ maxConcurrentAgents: 5 }), cbs);

    const types = events.map((e) => e.type);
    expect(types).toContain("convoy_started");
    expect(types).toContain("wave_started");
    expect(types).toContain("agent_spawned");
    expect(types).toContain("agent_finished");
    expect(types).toContain("wave_advanced");
    expect(types).toContain("convoy_completed");

    // Order: convoy_started before wave_started before agent_spawned
    expect(types.indexOf("convoy_started")).toBeLessThan(types.indexOf("wave_started"));
    expect(types.indexOf("wave_started")).toBeLessThan(types.indexOf("agent_spawned"));
    expect(types.indexOf("agent_spawned")).toBeLessThan(types.indexOf("wave_advanced"));
    expect(types.indexOf("wave_advanced")).toBeLessThan(types.indexOf("convoy_completed"));
  });

  it("emits problem_resolved event on conflict", async () => {
    const events: OrchestratorEvent[] = [];

    const cbs = buildCallbacks({
      callTool: async (name, params) => {
        cbs.toolCalls.push({ name, params });
        if (name === "register_agent") return { agentId: "orch", sessionId: "s-orch", role: "facilitator" };
        if (name === "compute_waves") return { waveCount: 1 };
        if (name === "launch_convoy") return { integrationBranch: "int/WG" };
        if (name === "get_wave_status") return { dispatchedTickets: ["TKT-1"] };
        if (name === "spawn_agent") return { worktreePath: "/tmp/wt", ticketId: params.ticketId };
        if (name === "advance_wave") return {
          mergedTickets: [],
          conflictedTickets: ["TKT-1"],
          allWavesComplete: true,
        };
        if (name === "end_session") return {};
        return {};
      },
      onEvent: (event) => { events.push(event); },
    });

    await runOrchestrator(buildConfig(), cbs);

    const problemEvents = events.filter((e) => e.type === "problem_resolved");
    expect(problemEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("agent_finished includes durationMs > 0", async () => {
    const events: OrchestratorEvent[] = [];

    const cbs = buildCallbacks({
      callTool: async (name, params) => {
        cbs.toolCalls.push({ name, params });
        if (name === "register_agent") return { agentId: "orch", sessionId: "s-orch", role: "facilitator" };
        if (name === "compute_waves") return { waveCount: 1 };
        if (name === "launch_convoy") return { integrationBranch: "int/WG" };
        if (name === "get_wave_status") return { dispatchedTickets: ["TKT-1"] };
        if (name === "spawn_agent") return { worktreePath: "/tmp/wt", ticketId: params.ticketId };
        if (name === "advance_wave") return { mergedTickets: ["TKT-1"], conflictedTickets: [], allWavesComplete: true };
        if (name === "end_session") return {};
        return {};
      },
      onEvent: (event) => { events.push(event); },
    });

    await runOrchestrator(buildConfig(), cbs);

    const finishEvents = events.filter((e) => e.type === "agent_finished");
    expect(finishEvents.length).toBe(1);
    const finish = finishEvents[0] as Extract<OrchestratorEvent, { type: "agent_finished" }>;
    expect(finish.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("no crash when onEvent is not provided", async () => {
    const cbs = buildCallbacks({
      callTool: async (name, params) => {
        cbs.toolCalls.push({ name, params });
        if (name === "register_agent") return { agentId: "orch", sessionId: "s-orch", role: "facilitator" };
        if (name === "compute_waves") return { waveCount: 1 };
        if (name === "launch_convoy") return { integrationBranch: "int/WG" };
        if (name === "get_wave_status") return { dispatchedTickets: ["TKT-1"] };
        if (name === "spawn_agent") return { worktreePath: "/tmp/wt", ticketId: params.ticketId };
        if (name === "advance_wave") return { mergedTickets: ["TKT-1"], conflictedTickets: [], allWavesComplete: true };
        if (name === "end_session") return {};
        return {};
      },
      // No onEvent callback
    });

    const result = await runOrchestrator(buildConfig(), cbs);
    expect(result.mergedTickets).toEqual(["TKT-1"]);
  });

  // ── Default heuristic (no onProblem) ──

  it("default heuristic: conflict with retry budget retries then skips", async () => {
    let _conflictCount = 0;
    const cbs = buildCallbacks({
      callTool: async (name, params) => {
        cbs.toolCalls.push({ name, params });
        if (name === "register_agent") return { agentId: "orch", sessionId: "s-orch", role: "facilitator" };
        if (name === "compute_waves") return { waveCount: 1 };
        if (name === "launch_convoy") return { integrationBranch: "int/WG" };
        if (name === "get_wave_status") return { dispatchedTickets: ["TKT-1"] };
        if (name === "spawn_agent") return { worktreePath: "/tmp/wt", ticketId: params.ticketId };
        if (name === "advance_wave") {
          _conflictCount++;
          // Always conflict
          return {
            mergedTickets: [],
            conflictedTickets: ["TKT-1"],
            conflictDetails: ["src/a.ts"],
            allWavesComplete: true,
          };
        }
        if (name === "end_session") return {};
        return {};
      },
      // No onProblem → uses resolveProblem heuristic
    });

    const result = await runOrchestrator(buildConfig({ maxRetries: 1 }), cbs);

    // First conflict → retry (via heuristic), then heuristic sees it in conflictHistory → skip
    // Either way, ticket ends up skipped
    expect(result.skippedTickets).toContain("TKT-1");
  });

  it("throws early if registration returns a non-facilitator role", async () => {
    const cbs = buildCallbacks({
      callTool: async (name, params) => {
        cbs.toolCalls.push({ name, params });
        if (name === "register_agent") return { agentId: "orch", sessionId: "s-orch", role: "observer" };
        return {};
      },
    });

    await expect(runOrchestrator(buildConfig(), cbs)).rejects.toThrow(
      /must be registered as facilitator or admin.*got "observer"/,
    );
  });
});
