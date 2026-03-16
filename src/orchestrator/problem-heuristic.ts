/**
 * Deterministic problem resolution for the orchestrator.
 *
 * Replaces the "skip everything" default with context-aware decisions:
 * - Conflicts: retry once, skip on repeat
 * - Test failures: skip culprit, abort if unknown and early in wave
 * - Timeouts: always skip
 * - Spawn failures: retry if budget allows
 */

import type { OrchestratorProblem, OrchestratorDecision } from "./loop.js";

export interface ProblemContext {
  /** Retries remaining for this specific ticket. */
  retriesRemaining: number;
  /** Total tickets dispatched in the current wave. */
  waveTicketCount: number;
  /** Tickets already merged this wave. */
  completedTicketCount: number;
  /** TicketIds that have conflicted before (accumulated across waves). */
  conflictHistory: string[];
}

export function resolveProblem(
  problem: OrchestratorProblem,
  context: ProblemContext,
): OrchestratorDecision {
  switch (problem.kind) {
    case "conflict":
      // Repeat offender → skip
      if (context.conflictHistory.includes(problem.ticketId)) return { action: "skip" };
      // First conflict with retry budget → retry
      if (context.retriesRemaining > 0) return { action: "retry" };
      return { action: "skip" };

    case "test_failure":
      // Known culprit → skip it
      if (problem.culprit) return { action: "skip" };
      // Unknown culprit: abort if early in wave (too much uncertainty)
      if (context.completedTicketCount / Math.max(context.waveTicketCount, 1) >= 0.5) {
        return { action: "skip" };
      }
      return { action: "abort" };

    case "timeout":
      return { action: "skip" };

    case "spawn_failure":
      if (context.retriesRemaining > 0) return { action: "retry" };
      return { action: "skip" };
  }
}
