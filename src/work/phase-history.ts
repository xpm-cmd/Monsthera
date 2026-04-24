import type { WorkPhase as WorkPhaseType, Timestamp } from "../core/types.js";
import type { PhaseHistoryEntry, AdvancePhaseOptions } from "./repository.js";

/**
 * Build the phase-history entry for a cancellation. `reason` is validated
 * upstream (at the service boundary) but this helper accepts the full
 * options object for symmetry with `buildAdvanceHistoryEntry`.
 *
 * Tier 2.1 — if the caller also supplied a `skipGuard.reason` (i.e. a
 * structurally-invalid-but-bypassed-guard cancellation), both reasons are
 * merged into a single entry using the format
 * `"cancellation: <r1>; skipped guards: <r2>"`. That exact prefix convention
 * lets downstream tooling recover each reason deterministically.
 */
export function buildCancellationHistoryEntry(
  phase: WorkPhaseType,
  enteredAt: Timestamp,
  options: AdvancePhaseOptions | undefined,
  skippedGuards: readonly string[],
): PhaseHistoryEntry {
  const cancelReason = options?.reason ?? "";
  const skipReason = options?.skipGuard?.reason;
  let reason: string | undefined = cancelReason.length > 0 ? cancelReason : undefined;
  if (skipReason && skippedGuards.length > 0) {
    reason = cancelReason.length > 0
      ? `cancellation: ${cancelReason}; skipped guards: ${skipReason}`
      : `skipped guards: ${skipReason}`;
  }
  const entry: PhaseHistoryEntry = {
    phase,
    enteredAt,
    ...(reason ? { reason } : {}),
    ...(skippedGuards.length > 0 ? { skippedGuards: [...skippedGuards] } : {}),
    ...(options?.metadata && Object.keys(options.metadata).length > 0
      ? { metadata: { ...options.metadata } }
      : {}),
  };
  return entry;
}

/**
 * Build the phase-history entry for a non-cancellation advance. Records the
 * optional structured `metadata` alongside any Tier 2.1 `skipGuard` audit data
 * — both are independent so an advance can carry either, both, or neither.
 */
export function buildAdvanceHistoryEntry(
  phase: WorkPhaseType,
  enteredAt: Timestamp,
  options: AdvancePhaseOptions | undefined,
  skippedGuards: readonly string[],
): PhaseHistoryEntry {
  const hasMetadata = !!options?.metadata && Object.keys(options.metadata).length > 0;

  if (skippedGuards.length === 0 && !hasMetadata) {
    return { phase, enteredAt };
  }

  const skipReason = options?.skipGuard?.reason;
  return {
    phase,
    enteredAt,
    ...(skipReason ? { reason: skipReason } : {}),
    ...(skippedGuards.length > 0 ? { skippedGuards: [...skippedGuards] } : {}),
    ...(hasMetadata ? { metadata: { ...options!.metadata! } } : {}),
  };
}
