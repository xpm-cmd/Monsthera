import type { Result } from "../core/result.js";
import { ok, err } from "../core/result.js";
import { StateTransitionError, GuardFailedError } from "../core/errors.js";
import { WorkPhase } from "../core/types.js";
import type { WorkPhase as WorkPhaseType } from "../core/types.js";
import type { WorkArticle } from "./repository.js";
import {
  has_objective,
  has_acceptance_criteria,
  min_enrichment_met,
  implementation_linked,
  all_reviewers_approved,
  snapshot_ready,
  SNAPSHOT_READY_RECOVERY_HINT,
  policy_requirements_met,
} from "./guards.js";
import { WORK_TEMPLATES } from "./templates.js";
import type { SnapshotService } from "../context/snapshot-service.js";
import type { Policy } from "./policy-loader.js";

// ─── State Machine ──────────────────────────────────────────────────────────

/** Terminal phases that cannot transition to anything */
const TERMINAL_PHASES = new Set<WorkPhaseType>([WorkPhase.DONE, WorkPhase.CANCELLED]);

// ─── Guard Sets ─────────────────────────────────────────────────────────────

export interface GuardEntry {
  readonly name: string;
  readonly check: (article: WorkArticle) => boolean;
}

/** Async guards consult dependencies that are not embedded in the article. */
export interface AsyncGuardEntry {
  readonly name: string;
  readonly check: (article: WorkArticle) => Promise<boolean>;
  /**
   * Agent-facing recovery text appended to `GuardFailedError.message` when
   * this guard blocks a transition. Optional — guards without a well-defined
   * recovery path stay silent. Exists so an agent reading the error can act
   * without cross-referencing an ADR.
   */
  readonly recoveryHint?: string;
}

/**
 * Extra data passed into async guard evaluation. Kept per-call (not per-repo)
 * so the repository stays stateless w.r.t. the snapshot service. `snapshotService`
 * is optional: when a template opts into `snapshot_ready` but the deps are
 * missing, the guard fails closed.
 */
export interface GuardDeps {
  readonly snapshotService?: SnapshotService;
  /** Pre-computed sha256 of each HEAD lockfile keyed by relative path. */
  readonly headLockfileHashes?: Record<string, string>;
}

/**
 * Extra per-call context for guard assembly. `policies` is the full set of
 * loaded policies — `getGuardSet` filters to the ones that apply to this
 * article + transition and appends a `policy_requirements_met` entry when
 * any apply. Policies do not gate `planning->enrichment` because that
 * transition runs before there is enough content to match against.
 */
export interface GuardSetDeps {
  readonly policies?: readonly Policy[];
  readonly applicablePolicyFilter?: (
    policies: readonly Policy[],
    article: WorkArticle,
    transition: { from: WorkPhaseType; to: WorkPhaseType },
  ) => readonly Policy[];
}

/** Get the guard set for a specific transition. Returns empty array for cancellation. */
export function getGuardSet(
  article: WorkArticle,
  from: WorkPhaseType,
  to: WorkPhaseType,
  deps?: GuardSetDeps,
): GuardEntry[] {
  const key = `${from}:${to}`;
  const baseGuards: GuardEntry[] = (() => {
    switch (key) {
      case "planning:enrichment": {
        const guards: GuardEntry[] = [
          { name: "has_objective", check: has_objective },
        ];
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
        return [{ name: "implementation_linked", check: implementation_linked }];
      case "review:done":
        return [{ name: "all_reviewers_approved", check: all_reviewers_approved }];
      default:
        return [];
    }
  })();

  // Policies gate every transition except planning→enrichment (not enough content yet).
  const isPlanningToEnrichment = from === WorkPhase.PLANNING && to === WorkPhase.ENRICHMENT;
  if (!isPlanningToEnrichment && deps?.policies && deps.policies.length > 0) {
    const filter = deps.applicablePolicyFilter;
    const applicable = filter
      ? filter(deps.policies, article, { from, to })
      : deps.policies;
    if (applicable.length > 0) {
      baseGuards.push({
        name: "policy_requirements_met",
        check: (a) => policy_requirements_met(a, { policies: applicable }),
      });
    }
  }

  return baseGuards;
}

/**
 * Async guard set for a transition. Separate from `getGuardSet` so pure
 * guards stay dependency-free. Returns an empty array when the template does
 * not opt in, when the transition is not gated by an async predicate, or
 * when the caller does not supply the deps required to evaluate the guard —
 * unenforced ≠ failed, and dependency-less callers (unit tests, repo-level
 * use sites) must keep the legacy fast path.
 */
export function getAsyncGuardSet(
  article: WorkArticle,
  from: WorkPhaseType,
  to: WorkPhaseType,
  deps?: GuardDeps,
): AsyncGuardEntry[] {
  if (from === WorkPhase.ENRICHMENT && to === WorkPhase.IMPLEMENTATION) {
    const templateConfig = WORK_TEMPLATES[article.template];
    if (templateConfig.requiresSnapshotForImplementation && deps?.snapshotService) {
      return [
        {
          name: "snapshot_ready",
          check: (a) => snapshot_ready(a, deps),
          recoveryHint: SNAPSHOT_READY_RECOVERY_HINT,
        },
      ];
    }
  }
  return [];
}

/**
 * Evaluate the async guard set for a transition. Mirrors the bypass semantics
 * of the sync evaluator: when `skipGuard` is set, failing guards are recorded
 * in `skippedGuards` instead of short-circuiting with an error.
 */
export async function evaluateAsyncGuards(
  article: WorkArticle,
  from: WorkPhaseType,
  to: WorkPhaseType,
  options: CheckTransitionOptions = {},
  deps?: GuardDeps,
): Promise<Result<{ readonly skippedGuards: readonly string[] }, GuardFailedError>> {
  const guards = getAsyncGuardSet(article, from, to, deps);
  const failed: string[] = [];
  for (const guard of guards) {
    const pass = await guard.check(article);
    if (!pass) {
      if (!options.skipGuard) {
        const base = `Guard "${guard.name}" failed for transition from "${from}" to "${to}"`;
        const message = guard.recoveryHint ? `${base}. ${guard.recoveryHint}` : base;
        return err(new GuardFailedError(guard.name, message));
      }
      failed.push(guard.name);
    }
  }
  return ok({ skippedGuards: failed });
}

/**
 * Get the next forward phase for this article's template, or null if the
 * article is in a terminal phase or no forward edge is defined. Tier 2.1 —
 * template-aware, so spike articles advance enrichment→done directly.
 */
export function getNextPhase(article: WorkArticle): WorkPhaseType | null {
  if (TERMINAL_PHASES.has(article.phase)) return null;
  const graph = WORK_TEMPLATES[article.template].phaseGraph;
  const edge = graph.find((e) => e.startsWith(`${article.phase}:`));
  if (!edge) return null;
  const [, to] = edge.split(":") as [WorkPhaseType, WorkPhaseType];
  return to;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Check whether a transition is structurally valid for a specific article.
 * Terminal phases cannot transition. Cancellation is always valid from
 * non-terminal phases. All other forward transitions must appear in the
 * article's template `phaseGraph`.
 */
export function isValidTransition(article: WorkArticle, to: WorkPhaseType): boolean {
  const from = article.phase;
  if (TERMINAL_PHASES.has(from)) return false;
  if (to === WorkPhase.CANCELLED) return true;
  const graph = WORK_TEMPLATES[article.template].phaseGraph;
  return graph.includes(`${from}:${to}` as const);
}

/** Options for `checkTransition` (Tier 2.1). */
export interface CheckTransitionOptions {
  /** When present, guard failures do not block the transition; the names of the
   * bypassed guards are returned so the caller can record them in history. */
  readonly skipGuard?: { readonly reason: string };
}

/** Success shape of `checkTransition`. `skippedGuards` is populated only when
 * the `skipGuard` option actually bypassed one or more failing guards. */
export interface TransitionSuccess {
  readonly targetPhase: WorkPhaseType;
  readonly skippedGuards: readonly string[];
}

/**
 * Check if a work article can transition to the target phase.
 * Validates structural transition legality AND evaluates all guards.
 *
 * Returns ok({targetPhase, skippedGuards}) if transition is allowed.
 * Returns err(StateTransitionError) if transition is structurally invalid.
 * Returns err(GuardFailedError) if a guard fails and `skipGuard` is not set.
 *
 * When `options.skipGuard` is provided, failing guards are collected and the
 * transition succeeds with those guard names in `skippedGuards`. Structural
 * invalidity is never bypassed.
 */
export function checkTransition(
  article: WorkArticle,
  targetPhase: WorkPhaseType,
  options: CheckTransitionOptions = {},
): Result<TransitionSuccess, StateTransitionError | GuardFailedError> {
  const from = article.phase;

  // 1. Terminal phase check
  if (TERMINAL_PHASES.has(from)) {
    return err(new StateTransitionError(from, targetPhase, `Phase "${from}" is terminal`));
  }

  // 2. Structural validity check (skipGuard does NOT bypass this)
  if (!isValidTransition(article, targetPhase)) {
    return err(new StateTransitionError(from, targetPhase, `Transition from "${from}" to "${targetPhase}" is not valid`));
  }

  // 3. Cancellation bypass — no guards needed
  if (targetPhase === WorkPhase.CANCELLED) {
    return ok({ targetPhase, skippedGuards: [] });
  }

  // 4. Evaluate guards in order
  const guards = getGuardSet(article, from, targetPhase);
  const failed: string[] = [];
  for (const guard of guards) {
    if (!guard.check(article)) {
      if (!options.skipGuard) {
        return err(new GuardFailedError(guard.name, `Guard "${guard.name}" failed for transition from "${from}" to "${targetPhase}"`));
      }
      failed.push(guard.name);
    }
  }

  return ok({ targetPhase, skippedGuards: failed });
}
