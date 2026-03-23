/**
 * Deterministic orchestrator loop that drives convoy lifecycle.
 *
 * 90% deterministic — only invokes LLM (via onProblem callback) when problems occur.
 * Falls back to deterministic resolveProblem() heuristic when no onProblem is set.
 */

import { resolveProblem, type ProblemContext } from "./problem-heuristic.js";

export interface OrchestratorConfig {
  groupId: string;
  maxConcurrentAgents: number;
  testCommand?: string;
  testTimeoutMs?: number;
  pollIntervalMs?: number;
  llmFallback?: boolean;
  repoPath: string;
  maxRetries?: number; // default 1
}

export interface OrchestratorCallbacks {
  callTool: (name: string, params: Record<string, unknown>) => Promise<unknown>;
  spawnProcess: (worktreePath: string, ticketId: string) => Promise<SpawnedAgent>;
  killProcess: (pid: number) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  log: (level: "info" | "warn" | "error", msg: string) => void;
  sleep: (ms: number) => Promise<void>;
  onProblem?: (problem: OrchestratorProblem) => Promise<OrchestratorDecision>;
  onEvent?: (event: OrchestratorEvent) => void;
  cleanupWorktrees?: () => Promise<void>;
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

export type OrchestratorEvent =
  | { type: "convoy_started"; groupId: string; totalWaves: number; integrationBranch: string }
  | { type: "wave_started"; groupId: string; wave: number; ticketCount: number }
  | { type: "agent_spawned"; groupId: string; ticketId: string; pid: number }
  | { type: "agent_finished"; groupId: string; ticketId: string; pid: number; durationMs: number }
  | { type: "agent_timeout"; groupId: string; ticketId: string; pid: number }
  | { type: "wave_advanced"; groupId: string; wave: number; merged: string[]; skipped: string[] }
  | { type: "problem_resolved"; groupId: string; problem: OrchestratorProblem; decision: OrchestratorDecision }
  | { type: "convoy_completed"; groupId: string; result: OrchestratorResult };

interface ActiveProcess {
  pid: number;
  stalePollCount: number;
  startedAt: number;
}

const MAX_STALE_POLLS = 5;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const obj = value as Record<string, unknown>;
  // MCP tool responses wrap data in { content: [{ type: "text", text: "{...}" }] }
  if (Array.isArray(obj.content)) {
    const first = obj.content[0] as Record<string, unknown> | undefined;
    if (first && typeof first.text === "string") {
      try {
        const parsed = JSON.parse(first.text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // fall through to return raw object
      }
    }
  }
  return obj;
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
  const emit = callbacks.onEvent ?? (() => {});
  const mergedTickets: string[] = [];
  const skippedTickets: string[] = [];
  const failedTickets: string[] = [];
  const conflictHistory: string[] = [];
  const retryBudget = new Map<string, number>();
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

  const buildProblemContext = (ticketId: string, waveTicketCount: number): ProblemContext => ({
    retriesRemaining: retryBudget.get(ticketId) ?? 0,
    waveTicketCount,
    completedTicketCount: mergedTickets.length,
    conflictHistory,
  });

  // 1. REGISTER as facilitator
  const regResult = asRecord(await callbacks.callTool("register_agent", {
    name: "orchestrator",
    desiredRole: "facilitator",
  }));
  if (!regResult.agentId || !regResult.sessionId) {
    throw new Error(`register_agent failed: missing agentId or sessionId in response: ${JSON.stringify(regResult)}`);
  }
  const agentId = String(regResult.agentId);
  const sessionId = String(regResult.sessionId);
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
  const integrationBranch = String(launchResult.integrationBranch ?? "unknown");
  callbacks.log("info", `Convoy launched: integration branch ${integrationBranch}`);
  emit({ type: "convoy_started", groupId: config.groupId, totalWaves, integrationBranch });

  // 4. FOR each wave (dynamic: totalWaves may grow via auto-refresh)
  let wave = 0;
  while (wave < totalWaves) {
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

    emit({ type: "wave_started", groupId: config.groupId, wave: wave + 1, ticketCount: waveTickets.length });

    // Initialize retry budget for wave tickets
    for (const ticketId of waveTickets) {
      if (!retryBudget.has(ticketId)) {
        retryBudget.set(ticketId, config.maxRetries ?? 1);
      }
    }

    // 4b. SPAWN agents (throttled)
    const activeProcesses = new Map<string, ActiveProcess>();
    const waveSkipped: string[] = [];

    for (const ticketId of waveTickets) {
      // Throttle: wait until a slot opens
      while (activeProcesses.size >= config.maxConcurrentAgents) {
        await callbacks.sleep(pollIntervalMs);
        reapFinishedProcesses(activeProcesses, isAlive, callbacks, emit, config.groupId);
        await handleTimeouts(activeProcesses, config, callbacks, skippedTickets, emit, config.groupId, buildProblemContext, waveTickets.length);
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
          startedAt: Date.now(),
        });
        callbacks.log("info", `Spawned agent for ${ticketId} (pid=${spawned.pid})`);
        emit({ type: "agent_spawned", groupId: config.groupId, ticketId, pid: spawned.pid });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const problem: OrchestratorProblem = { kind: "spawn_failure", ticketId, error };
        const ctx = buildProblemContext(ticketId, waveTickets.length);
        const decision = await handleProblem(callbacks, problem, ctx);
        emit({ type: "problem_resolved", groupId: config.groupId, problem, decision });

        if (decision.action === "abort") {
          callbacks.log("error", "Aborting orchestration due to spawn failure");
          emit({ type: "convoy_completed", groupId: config.groupId, result: buildResult() });
          return buildResult();
        }
        if (decision.action === "retry") {
          decrementRetryBudget(retryBudget, ticketId);
        }
        skippedTickets.push(ticketId);
        waveSkipped.push(ticketId);
        callbacks.log("warn", `Skipped ${ticketId} (spawn failure: ${error})`);
      }
    }

    // 4c. POLL until wave complete — processes that exit are reaped as done
    while (activeProcesses.size > 0) {
      await callbacks.sleep(pollIntervalMs);
      reapFinishedProcesses(activeProcesses, isAlive, callbacks, emit, config.groupId);
      await handleTimeouts(activeProcesses, config, callbacks, skippedTickets, emit, config.groupId, buildProblemContext, waveTickets.length);
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
      const problem: OrchestratorProblem = {
        kind: "conflict",
        ticketId,
        conflicts: asStringArray(advanceResult.conflictDetails),
      };
      const ctx = buildProblemContext(ticketId, waveTickets.length);
      const decision = await handleProblem(callbacks, problem, ctx);
      emit({ type: "problem_resolved", groupId: config.groupId, problem, decision });

      if (decision.action === "retry") {
        // Retry means: skip this wave, but mark for potential re-attempt
        decrementRetryBudget(retryBudget, ticketId);
        conflictHistory.push(ticketId);
        skippedTickets.push(ticketId);
        waveSkipped.push(ticketId);
        callbacks.log("warn", `Skipped ${ticketId} (conflict, may retry in future wave)`);
      } else if (decision.action === "abort") {
        callbacks.log("error", "Aborting orchestration due to conflict");
        emit({ type: "convoy_completed", groupId: config.groupId, result: buildResult() });
        return buildResult();
      } else {
        skippedTickets.push(ticketId);
        waveSkipped.push(ticketId);
        callbacks.log("warn", `Skipped ${ticketId} (conflict)`);
      }
    }

    // Handle test failures
    if (advanceResult.testFailed) {
      const culprit = advanceResult.bisectCulprit ? String(advanceResult.bisectCulprit) : null;
      const problem: OrchestratorProblem = {
        kind: "test_failure",
        ticketId: culprit ?? "unknown",
        culprit,
      };
      const ctx = buildProblemContext(culprit ?? "unknown", waveTickets.length);
      const decision = await handleProblem(callbacks, problem, ctx);
      emit({ type: "problem_resolved", groupId: config.groupId, problem, decision });

      if (decision.action === "abort") {
        callbacks.log("error", "Aborting orchestration due to test failure");
        emit({ type: "convoy_completed", groupId: config.groupId, result: buildResult() });
        return buildResult();
      }
      if (culprit) {
        skippedTickets.push(culprit);
        waveSkipped.push(culprit);
        callbacks.log("warn", `Skipped ${culprit} (test failure, bisected)`);
      }
    }

    // Check if auto-refresh extended the convoy with new waves
    const autoRefresh = asRecord(advanceResult.autoRefresh ?? {});
    const absorbedTickets = asStringArray(autoRefresh.absorbed);
    const appendedNewWaves = Number(autoRefresh.appendedNewWaves ?? 0);
    if (absorbedTickets.length > 0) {
      totalWaves += appendedNewWaves;
      const filledExisting = Number(autoRefresh.filledExistingWaves ?? 0);
      callbacks.log("info", `Auto-refresh: absorbed ${absorbedTickets.length} ticket(s) (${filledExisting} filled existing, ${appendedNewWaves} new wave(s)). Total waves: ${totalWaves}`);
    }

    // Track merged tickets from this wave
    const waveMerged = asStringArray(advanceResult.mergedTickets);
    mergedTickets.push(...waveMerged);

    emit({ type: "wave_advanced", groupId: config.groupId, wave: wave + 1, merged: waveMerged, skipped: waveSkipped });

    wavesCompleted++;

    if (advanceResult.allWavesComplete) {
      finalMerged = true;
      callbacks.log("info", "All waves complete — final merge successful");
      break;
    }

    wave++;
  }

  // 5. END session
  try {
    await callbacks.callTool("end_session", { agentId, sessionId });
  } catch {
    // non-fatal
  }

  // 6. CLEANUP worktrees
  if (callbacks.cleanupWorktrees) {
    try {
      await callbacks.cleanupWorktrees();
    } catch {
      // non-fatal
    }
  }

  const result = buildResult();
  emit({ type: "convoy_completed", groupId: config.groupId, result });
  return result;
}

/** Remove finished processes (those whose PID is no longer alive). */
function reapFinishedProcesses(
  activeProcesses: Map<string, ActiveProcess>,
  isAlive: (pid: number) => boolean,
  callbacks: OrchestratorCallbacks,
  emit: (event: OrchestratorEvent) => void,
  groupId: string,
): void {
  for (const [ticketId, proc] of activeProcesses) {
    if (!isAlive(proc.pid)) {
      const durationMs = Date.now() - proc.startedAt;
      callbacks.log("info", `Agent for ${ticketId} finished (pid=${proc.pid}, ${durationMs}ms)`);
      emit({ type: "agent_finished", groupId, ticketId, pid: proc.pid, durationMs });
      activeProcesses.delete(ticketId);
    } else {
      proc.stalePollCount++;
    }
  }
}

/** Handle timeout for agents that have been stale for too many poll cycles. */
async function handleTimeouts(
  activeProcesses: Map<string, ActiveProcess>,
  config: OrchestratorConfig,
  callbacks: OrchestratorCallbacks,
  skippedTickets: string[],
  emit: (event: OrchestratorEvent) => void,
  groupId: string,
  buildCtx: (ticketId: string, waveTicketCount: number) => ProblemContext,
  waveTicketCount: number,
): Promise<void> {
  for (const [ticketId, proc] of activeProcesses) {
    if (proc.stalePollCount >= MAX_STALE_POLLS) {
      callbacks.log("warn", `${ticketId} timed out after ${MAX_STALE_POLLS} poll cycles`);
      try {
        await callbacks.killProcess(proc.pid);
      } catch {
        // best-effort kill
      }

      emit({ type: "agent_timeout", groupId, ticketId, pid: proc.pid });

      const problem: OrchestratorProblem = {
        kind: "timeout",
        ticketId,
        elapsedMs: proc.stalePollCount * (config.pollIntervalMs ?? 10_000),
      };
      const ctx = buildCtx(ticketId, waveTicketCount);
      const decision = await handleProblem(callbacks, problem, ctx);
      emit({ type: "problem_resolved", groupId, problem, decision });

      skippedTickets.push(ticketId);
      activeProcesses.delete(ticketId);
    }
  }
}

async function handleProblem(
  callbacks: OrchestratorCallbacks,
  problem: OrchestratorProblem,
  context?: ProblemContext,
): Promise<OrchestratorDecision> {
  if (callbacks.onProblem) {
    return callbacks.onProblem(problem);
  }
  if (context) {
    return resolveProblem(problem, context);
  }
  return { action: "skip" };
}

function decrementRetryBudget(budget: Map<string, number>, ticketId: string): void {
  const remaining = budget.get(ticketId) ?? 0;
  budget.set(ticketId, Math.max(0, remaining - 1));
}
