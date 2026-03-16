/**
 * Deterministic orchestrator loop that drives convoy lifecycle.
 *
 * 90% deterministic — only invokes LLM (via onProblem callback) when problems occur.
 */

export interface OrchestratorConfig {
  groupId: string;
  maxConcurrentAgents: number;
  testCommand?: string;
  testTimeoutMs?: number;
  pollIntervalMs?: number;
  llmFallback?: boolean;
  repoPath: string;
}

export interface OrchestratorCallbacks {
  callTool: (name: string, params: Record<string, unknown>) => Promise<unknown>;
  spawnProcess: (worktreePath: string, ticketId: string) => Promise<SpawnedAgent>;
  killProcess: (pid: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  sleep: (ms: number) => Promise<void>;
  onProblem?: (problem: OrchestratorProblem) => Promise<OrchestratorDecision>;
}

export interface SpawnedAgent {
  pid: number;
  ticketId: string;
  sessionId: string;
}

export type OrchestratorProblem =
  | { kind: "conflict"; ticketId: string; conflicts: string[] }
  | { kind: "test_failure"; ticketId: string; culprit: string | null }
  | { kind: "timeout"; ticketId: string; elapsedMs: number }
  | { kind: "spawn_failure"; ticketId: string; error: string };

export type OrchestratorDecision =
  | { action: "retry" }
  | { action: "skip" }
  | { action: "abort" };

export interface OrchestratorResult {
  groupId: string;
  wavesCompleted: number;
  totalWaves: number;
  mergedTickets: string[];
  skippedTickets: string[];
  failedTickets: string[];
  finalMerged: boolean;
  durationMs: number;
}

const MAX_STALE_POLLS = 5;

function asRecord(value: unknown): Record<string, unknown> {
  return (value && typeof value === "object" && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runOrchestrator(
  config: OrchestratorConfig,
  callbacks: OrchestratorCallbacks,
): Promise<OrchestratorResult> {
  const startedAt = Date.now();
  const pollIntervalMs = config.pollIntervalMs ?? 10_000;
  const isAlive = callbacks.isProcessAlive ?? defaultIsProcessAlive;
  const mergedTickets: string[] = [];
  const skippedTickets: string[] = [];
  const failedTickets: string[] = [];
  let wavesCompleted = 0;
  let totalWaves = 0;
  let finalMerged = false;

  const buildResult = (): OrchestratorResult => ({
    groupId: config.groupId,
    wavesCompleted,
    totalWaves,
    mergedTickets,
    skippedTickets,
    failedTickets,
    finalMerged,
    durationMs: Date.now() - startedAt,
  });

  // 1. REGISTER as facilitator
  const regResult = asRecord(await callbacks.callTool("register_agent", {
    name: "orchestrator",
    desiredRole: "facilitator",
  }));
  const agentId = String(regResult.agentId ?? "orchestrator");
  const sessionId = String(regResult.sessionId ?? "session-orch");
  callbacks.log("info", `Registered as ${agentId}`);

  // 2. COMPUTE waves
  const wavesResult = asRecord(await callbacks.callTool("compute_waves", {
    groupId: config.groupId,
    agentId,
    sessionId,
  }));
  totalWaves = Number(wavesResult.waveCount ?? 0);
  if (totalWaves === 0) {
    callbacks.log("warn", "No waves computed — nothing to do");
    return buildResult();
  }
  callbacks.log("info", `Computed ${totalWaves} wave(s)`);

  // 3. LAUNCH convoy
  const launchResult = asRecord(await callbacks.callTool("launch_convoy", {
    groupId: config.groupId,
    testCommand: config.testCommand,
    agentId,
    sessionId,
  }));
  callbacks.log("info", `Convoy launched: integration branch ${launchResult.integrationBranch ?? "unknown"}`);

  // 4. FOR each wave
  for (let wave = 0; wave < totalWaves; wave++) {
    callbacks.log("info", `=== Wave ${wave + 1}/${totalWaves} ===`);

    // 4a. Get current wave status to find dispatched tickets
    const waveStatus = asRecord(await callbacks.callTool("get_wave_status", {
      groupId: config.groupId,
      agentId,
      sessionId,
    }));
    const waveTickets = asStringArray(waveStatus.dispatchedTickets ?? waveStatus.currentWaveTickets);

    if (waveTickets.length === 0) {
      callbacks.log("warn", `Wave ${wave + 1} has no tickets — skipping`);
      wavesCompleted++;
      continue;
    }

    // 4b. SPAWN agents (throttled)
    const activeProcesses = new Map<string, { pid: number; stalePollCount: number }>();

    for (const ticketId of waveTickets) {
      // Throttle: wait until a slot opens
      while (activeProcesses.size >= config.maxConcurrentAgents) {
        await callbacks.sleep(pollIntervalMs);
        reapFinishedProcesses(activeProcesses, isAlive, callbacks);
        await handleTimeouts(activeProcesses, config, callbacks, skippedTickets);
      }

      try {
        const spawnResult = asRecord(await callbacks.callTool("spawn_agent", {
          ticketId,
          role: "developer",
          agentId,
          sessionId,
        }));

        const worktreePath = String(spawnResult.worktreePath ?? config.repoPath);
        const spawned = await callbacks.spawnProcess(worktreePath, ticketId);

        activeProcesses.set(ticketId, {
          pid: spawned.pid,
          stalePollCount: 0,
        });
        callbacks.log("info", `Spawned agent for ${ticketId} (pid=${spawned.pid})`);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const decision = await handleProblem(callbacks, { kind: "spawn_failure", ticketId, error });
        if (decision.action === "abort") {
          callbacks.log("error", "Aborting orchestration due to spawn failure");
          return buildResult();
        }
        skippedTickets.push(ticketId);
        callbacks.log("warn", `Skipped ${ticketId} (spawn failure: ${error})`);
      }
    }

    // 4c. POLL until wave complete — processes that exit are reaped as done
    while (activeProcesses.size > 0) {
      await callbacks.sleep(pollIntervalMs);
      reapFinishedProcesses(activeProcesses, isAlive, callbacks);
      await handleTimeouts(activeProcesses, config, callbacks, skippedTickets);
    }

    // 4d. ADVANCE wave
    callbacks.log("info", `Advancing wave ${wave + 1}...`);
    const advanceResult = asRecord(await callbacks.callTool("advance_wave", {
      groupId: config.groupId,
      testCommand: config.testCommand,
      testTimeoutMs: config.testTimeoutMs ?? 120_000,
      agentId,
      sessionId,
    }));

    // Handle conflicts from advance
    const conflicted = asStringArray(advanceResult.conflictedTickets);
    for (const ticketId of conflicted) {
      const decision = await handleProblem(callbacks, {
        kind: "conflict",
        ticketId,
        conflicts: asStringArray(advanceResult.conflictDetails),
      });
      if (decision.action === "abort") {
        callbacks.log("error", "Aborting orchestration due to conflict");
        return buildResult();
      }
      skippedTickets.push(ticketId);
      callbacks.log("warn", `Skipped ${ticketId} (conflict)`);
    }

    // Handle test failures
    if (advanceResult.testFailed) {
      const culprit = advanceResult.bisectCulprit ? String(advanceResult.bisectCulprit) : null;
      const decision = await handleProblem(callbacks, {
        kind: "test_failure",
        ticketId: culprit ?? "unknown",
        culprit,
      });
      if (decision.action === "abort") {
        callbacks.log("error", "Aborting orchestration due to test failure");
        return buildResult();
      }
      if (culprit) {
        skippedTickets.push(culprit);
        callbacks.log("warn", `Skipped ${culprit} (test failure, bisected)`);
      }
    }

    // Track merged tickets from this wave
    const waveMerged = asStringArray(advanceResult.mergedTickets);
    mergedTickets.push(...waveMerged);

    wavesCompleted++;

    if (advanceResult.allWavesComplete) {
      finalMerged = true;
      callbacks.log("info", "All waves complete — final merge successful");
      break;
    }
  }

  // 5. END session
  try {
    await callbacks.callTool("end_session", { agentId, sessionId });
  } catch {
    // non-fatal
  }

  return buildResult();
}

/** Remove finished processes (those whose PID is no longer alive). */
function reapFinishedProcesses(
  activeProcesses: Map<string, { pid: number; stalePollCount: number }>,
  isAlive: (pid: number) => boolean,
  callbacks: OrchestratorCallbacks,
): void {
  for (const [ticketId, proc] of activeProcesses) {
    if (!isAlive(proc.pid)) {
      callbacks.log("info", `Agent for ${ticketId} finished (pid=${proc.pid})`);
      activeProcesses.delete(ticketId);
    } else {
      proc.stalePollCount++;
    }
  }
}

/** Handle timeout for agents that have been stale for too many poll cycles. */
async function handleTimeouts(
  activeProcesses: Map<string, { pid: number; stalePollCount: number }>,
  config: OrchestratorConfig,
  callbacks: OrchestratorCallbacks,
  skippedTickets: string[],
): Promise<void> {
  for (const [ticketId, proc] of activeProcesses) {
    if (proc.stalePollCount >= MAX_STALE_POLLS) {
      callbacks.log("warn", `${ticketId} timed out after ${MAX_STALE_POLLS} poll cycles`);
      try {
        await callbacks.killProcess(proc.pid);
      } catch {
        // best-effort kill
      }

      const decision = await handleProblem(callbacks, {
        kind: "timeout",
        ticketId,
        elapsedMs: proc.stalePollCount * (config.pollIntervalMs ?? 10_000),
      });
      if (decision.action === "abort") {
        skippedTickets.push(ticketId);
      } else {
        skippedTickets.push(ticketId);
      }
      activeProcesses.delete(ticketId);
    }
  }
}

async function handleProblem(
  callbacks: OrchestratorCallbacks,
  problem: OrchestratorProblem,
): Promise<OrchestratorDecision> {
  if (callbacks.onProblem) {
    return callbacks.onProblem(problem);
  }
  return { action: "skip" };
}
