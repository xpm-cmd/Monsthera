import type { Result } from "../core/result.js";
import { ok, err } from "../core/result.js";
import { StateTransitionError, GuardFailedError } from "../core/errors.js";
import { WorkPhase } from "../core/types.js";
import type { WorkPhase as WorkPhaseType } from "../core/types.js";
import type { WorkArticle } from "./repository.js";
import { has_objective, has_acceptance_criteria, min_enrichment_met, implementation_linked, all_reviewers_approved } from "./guards.js";
import { WORK_TEMPLATES } from "./templates.js";

// ─── State Machine ──────────────────────────────────────────────────────────

/** Valid forward transitions between phases */
const VALID_TRANSITIONS = new Set([
  "planning:enrichment",
  "enrichment:implementation",
  "implementation:review",
  "review:done",
]);

/** Terminal phases that cannot transition to anything */
const TERMINAL_PHASES = new Set<WorkPhaseType>([WorkPhase.DONE, WorkPhase.CANCELLED]);

// ─── Guard Sets ─────────────────────────────────────────────────────────────

export interface GuardEntry {
  readonly name: string;
  readonly check: (article: WorkArticle) => boolean;
}

/** Get the guard set for a specific transition. Returns empty array for cancellation. */
export function getGuardSet(article: WorkArticle, from: WorkPhaseType, to: WorkPhaseType): GuardEntry[] {
  const key = `${from}:${to}`;
  switch (key) {
    case "planning:enrichment": {
      const guards: GuardEntry[] = [
        { name: "has_objective", check: has_objective },
      ];
      // Only require acceptance criteria if the template declares it
      const templateConfig = WORK_TEMPLATES[article.template];
      if (templateConfig.requiredSections.includes("Acceptance Criteria")) {
        guards.push({ name: "has_acceptance_criteria", check: has_acceptance_criteria });
      }
      return guards;
    }
    case "enrichment:implementation": {
      const config = WORK_TEMPLATES[article.template];
      return [
        { name: "min_enrichment_met", check: (a) => min_enrichment_met(a, config.minEnrichmentCount) },
      ];
    }
    case "implementation:review":
      return [
        { name: "implementation_linked", check: implementation_linked },
      ];
    case "review:done":
      return [
        { name: "all_reviewers_approved", check: all_reviewers_approved },
      ];
    default:
      return [];
  }
}

/** Get the next forward phase in the lifecycle, or null if none */
export function getNextPhase(phase: WorkPhaseType): WorkPhaseType | null {
  switch (phase) {
    case WorkPhase.PLANNING: return WorkPhase.ENRICHMENT;
    case WorkPhase.ENRICHMENT: return WorkPhase.IMPLEMENTATION;
    case WorkPhase.IMPLEMENTATION: return WorkPhase.REVIEW;
    case WorkPhase.REVIEW: return WorkPhase.DONE;
    default: return null;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Check if a transition from one phase to another is structurally valid
 * (without evaluating guards).
 */
export function isValidTransition(from: WorkPhaseType, to: WorkPhaseType): boolean {
  if (TERMINAL_PHASES.has(from)) return false;
  if (to === WorkPhase.CANCELLED) return true;
  return VALID_TRANSITIONS.has(`${from}:${to}`);
}

/**
 * Check if a work article can transition to the target phase.
 * Validates structural transition legality AND evaluates all guards.
 *
 * Returns ok(targetPhase) if transition is allowed.
 * Returns err(StateTransitionError) if transition is structurally invalid.
 * Returns err(GuardFailedError) if a guard fails.
 */
export function checkTransition(
  article: WorkArticle,
  targetPhase: WorkPhaseType,
): Result<WorkPhaseType, StateTransitionError | GuardFailedError> {
  const from = article.phase;

  // 1. Terminal phase check
  if (TERMINAL_PHASES.has(from)) {
    return err(new StateTransitionError(from, targetPhase, `Phase "${from}" is terminal`));
  }

  // 2. Structural validity check
  if (!isValidTransition(from, targetPhase)) {
    return err(new StateTransitionError(from, targetPhase, `Transition from "${from}" to "${targetPhase}" is not valid`));
  }

  // 3. Cancellation bypass — no guards needed
  if (targetPhase === WorkPhase.CANCELLED) {
    return ok(targetPhase);
  }

  // 4. Evaluate guards in order
  const guards = getGuardSet(article, from, targetPhase);
  for (const guard of guards) {
    if (!guard.check(article)) {
      return err(new GuardFailedError(guard.name, `Guard "${guard.name}" failed for transition from "${from}" to "${targetPhase}"`));
    }
  }

  // 5. All guards pass
  return ok(targetPhase);
}
