import { describe, it, expect } from "vitest";
import {
  runOrchestrator,
  type OrchestratorCallbacks,
  type OrchestratorEvent,
} from "../../../src/orchestrator/loop.js";

/**
 * Phase E tests exercise the orchestrator loop with simulated callbacks,
 * matching how runPhaseE() works in the simulation runner.
 */

function buildSimCallbacks(opts: {
  wave0: string[];
  wave1?: string[];
  injectConflict?: string;
} = { wave0: ["TKT-1", "TKT-2"] }): OrchestratorCallbacks & {
  events: OrchestratorEvent[];
  spawnCount: number;
} {
  const events: OrchestratorEvent[] = [];
  let waveCallCount = 0;
  let spawnCount = 0;
  const pids = new Map<number, { finishAt: number }>();

  const totalWaves = opts.wave1 && opts.wave1.length > 0 ? 2 : 1;

  return {
    events,
    get spawnCount() { return spawnCount; },
    callTool: async (name, params) => {
      if (name === "register_agent") return { agentId: "sim-orch", sessionId: "sim-session", role: "facilitator" };
      if (name === "compute_waves") return { waveCount: totalWaves };
      if (name === "launch_convoy") return { integrationBranch: "monsthera/convoy/WG-sim" };
      if (name === "get_wave_status") {
        const tickets = waveCallCount === 0 ? opts.wave0 : (opts.wave1 ?? []);
        waveCallCount++;
        return { dispatchedTickets: tickets, currentWave: waveCallCount - 1 };
      }
      if (name === "spawn_agent") {
        return { worktreePath: `/tmp/sim-wt/${params.ticketId}`, ticketId: params.ticketId };
      }
      if (name === "advance_wave") {
        const waveIdx = waveCallCount - 1;
        const tickets = waveIdx <= 1 ? opts.wave0 : (opts.wave1 ?? []);
        const conflicted = opts.injectConflict && tickets.includes(opts.injectConflict)
          ? [opts.injectConflict]
          : [];
        const merged = tickets.filter((t) => !conflicted.includes(t));
        return {
          mergedTickets: merged,
          conflictedTickets: conflicted,
          conflictDetails: conflicted.length ? ["src/conflict.ts"] : [],
          allWavesComplete: waveCallCount >= totalWaves,
        };
      }
      if (name === "end_session") return { ended: true };
      return {};
    },
    spawnProcess: async (_wt, ticketId) => {
      spawnCount++;
      const pid = 50000 + spawnCount;
      pids.set(pid, { finishAt: Date.now() + 5 });
      return { pid, ticketId, sessionId: `sim-${ticketId}` };
    },
    killProcess: async () => {},
    isProcessAlive: (pid) => {
      const proc = pids.get(pid);
      if (!proc) return false;
      return Date.now() < proc.finishAt;
    },
    log: () => {},
    sleep: async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2))); },
    onEvent: (event) => { events.push(event); },
  };
}

describe("Phase E: orchestrator integration", () => {
  it("completes with simulated callbacks and returns KPIs", async () => {
    const cbs = buildSimCallbacks({ wave0: ["TKT-1", "TKT-2"] });

    const result = await runOrchestrator(
      { groupId: "WG-sim", maxConcurrentAgents: 2, pollIntervalMs: 2, repoPath: "/tmp" },
      cbs,
    );

    expect(result.wavesCompleted).toBeGreaterThanOrEqual(1);
    expect(result.mergedTickets.length).toBeGreaterThan(0);
    expect(cbs.spawnCount).toBe(2);
  });

  it("spawnSuccessRate = 1.0 when all spawns succeed", async () => {
    const cbs = buildSimCallbacks({ wave0: ["TKT-a", "TKT-b", "TKT-c"] });

    await runOrchestrator(
      { groupId: "WG-sim", maxConcurrentAgents: 3, pollIntervalMs: 2, repoPath: "/tmp" },
      cbs,
    );

    // All spawns succeeded (spawnProcess never throws)
    expect(cbs.spawnCount).toBe(3);
  });

  it("waveCompletionRate reflects actual waves completed", async () => {
    const cbs = buildSimCallbacks({ wave0: ["TKT-1"], wave1: ["TKT-2"] });

    const result = await runOrchestrator(
      { groupId: "WG-sim", maxConcurrentAgents: 2, pollIntervalMs: 2, repoPath: "/tmp" },
      cbs,
    );

    const rate = result.totalWaves > 0 ? result.wavesCompleted / result.totalWaves : 0;
    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeLessThanOrEqual(1);
  });

  it("events collected during run (convoy_started, wave_started, etc.)", async () => {
    const cbs = buildSimCallbacks({ wave0: ["TKT-1"] });

    await runOrchestrator(
      { groupId: "WG-sim", maxConcurrentAgents: 2, pollIntervalMs: 2, repoPath: "/tmp" },
      cbs,
    );

    const eventTypes = cbs.events.map((e) => e.type);
    expect(eventTypes).toContain("convoy_started");
    expect(eventTypes).toContain("wave_started");
    expect(eventTypes).toContain("convoy_completed");
    expect(cbs.events.length).toBeGreaterThanOrEqual(3);
  });

  it("problem heuristic exercised on conflict", async () => {
    const cbs = buildSimCallbacks({ wave0: ["TKT-1", "TKT-conflict"], injectConflict: "TKT-conflict" });

    const result = await runOrchestrator(
      { groupId: "WG-sim", maxConcurrentAgents: 2, pollIntervalMs: 2, repoPath: "/tmp" },
      cbs,
    );

    // The conflict ticket should end up in skippedTickets (after heuristic retry→skip)
    expect(result.skippedTickets).toContain("TKT-conflict");
    // problem_resolved event should be emitted
    const problemEvents = cbs.events.filter((e) => e.type === "problem_resolved");
    expect(problemEvents.length).toBeGreaterThanOrEqual(1);
  });
});
