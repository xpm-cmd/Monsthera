import type { WorkArticle } from "./repository.js";
import type { SnapshotService } from "../context/snapshot-service.js";
import type { Policy } from "./policy-loader.js";

// ─── Content Guards ───

export function has_objective(article: WorkArticle): boolean {
  return article.content.includes("## Objective");
}

export function has_acceptance_criteria(article: WorkArticle): boolean {
  return article.content.includes("## Acceptance Criteria");
}

// ─── Enrichment Guards ───

// Note: the lifecycle layer will call this with the template's minEnrichmentCount
export function min_enrichment_met(article: WorkArticle, min: number): boolean {
  const count = article.enrichmentRoles.filter(
    (r) => r.status === "contributed" || r.status === "skipped"
  ).length;
  return count >= min;
}

// ─── Implementation Guards ───

export function implementation_linked(article: WorkArticle): boolean {
  return article.content.includes("## Implementation");
}

// ─── Review Guards ───

// Empty reviewers array returns false (no reviewers = not approved)
export function all_reviewers_approved(article: WorkArticle): boolean {
  return article.reviewers.length > 0 && article.reviewers.every((r) => r.status === "approved");
}

// ─── Policy Guards ───

/**
 * Context for `policy_requirements_met`. The orchestrator pre-loads and
 * pre-filters policies via `PolicyLoader.getApplicablePolicies` so this guard
 * receives only the policies relevant to the current article + transition.
 * Keeping the guard pure preserves its testability — no I/O here.
 */
export interface PolicyGuardContext {
  readonly policies: readonly Policy[];
}

/** Per-policy breakdown of what a work article is missing. */
export interface PolicyViolation {
  readonly policySlug: string;
  readonly missing: {
    readonly enrichmentRoles?: readonly string[];
    readonly referencedArticles?: readonly string[];
  };
}

/**
 * Returns true iff every applicable policy's `requires` are satisfied. Use
 * `getPolicyViolations` to get a structured breakdown of what is missing for
 * readiness reporting and error messages.
 */
export function policy_requirements_met(
  article: WorkArticle,
  context: PolicyGuardContext,
): boolean {
  return getPolicyViolations(article, context.policies).length === 0;
}

/**
 * Compute the structured violations for a set of applicable policies. Separate
 * from the boolean guard so the orchestrator can embed the "why" in log events
 * and readiness reports without re-checking.
 */
export function getPolicyViolations(
  article: WorkArticle,
  policies: readonly Policy[],
): readonly PolicyViolation[] {
  const contributedOrSkipped = new Set(
    article.enrichmentRoles
      .filter((r) => r.status === "contributed" || r.status === "skipped")
      .map((r) => r.role),
  );
  const referenced = new Set(article.references);

  const violations: PolicyViolation[] = [];
  for (const policy of policies) {
    const missingRoles = policy.requires.enrichmentRoles.filter(
      (role) => !contributedOrSkipped.has(role),
    );
    const missingRefs = policy.requires.referencedArticles.filter(
      (ref) => !referenced.has(ref),
    );

    if (missingRoles.length === 0 && missingRefs.length === 0) continue;

    const missing: PolicyViolation["missing"] = {
      ...(missingRoles.length > 0 ? { enrichmentRoles: missingRoles } : {}),
      ...(missingRefs.length > 0 ? { referencedArticles: missingRefs } : {}),
    };
    violations.push({ policySlug: policy.slug, missing });
  }
  return violations;
}

// ─── Snapshot Guards (async) ───

/**
 * Dependencies for async snapshot guards. Duplicated here (rather than imported
 * from `lifecycle.ts`) to keep this module importable without pulling in the
 * lifecycle machinery — guards.ts is the leaf file in the work module.
 */
export interface SnapshotGuardDeps {
  readonly snapshotService?: SnapshotService;
  readonly headLockfileHashes?: Record<string, string>;
}

/**
 * Agent-facing recovery line emitted alongside a `snapshot_ready` failure.
 * Exported so the guard-set builder and any test that asserts on the message
 * share a single source of truth — agents parsing the error must not get
 * different wording depending on which code path constructed it.
 */
export const SNAPSHOT_READY_RECOVERY_HINT =
  "Recovery: run `pnpm exec tsx scripts/capture-env-snapshot.ts --agent-id=<agent> --work-id=<work>` and pipe the JSON into `record_environment_snapshot`; then retry the advance, or pass `skipGuard: { reason }` to bypass with an audit trail.";

/**
 * `snapshot_ready` — async guard for the `enrichment -> implementation`
 * transition on templates that opt in. Requires:
 *
 * - a recorded snapshot for this work article (by `workId`),
 * - the snapshot is not flagged `stale` (controlled by
 *   `MONSTHERA_SNAPSHOT_MAX_AGE_MINUTES`, default 30 min; `0` disables the
 *   freshness check),
 * - every HEAD lockfile hash (pre-computed by the caller) matches the one
 *   captured in the snapshot. Missing lockfiles in the snapshot fail closed.
 *
 * When the snapshot service is not wired the guard fails closed — the caller
 * can always bypass with `skipGuard` if they know what they are doing.
 */
export async function snapshot_ready(
  article: WorkArticle,
  deps?: SnapshotGuardDeps,
): Promise<boolean> {
  if (!deps?.snapshotService) return false;
  const result = await deps.snapshotService.getLatest({ workId: article.id });
  if (!result.ok || !result.value) return false;

  const { snapshot, stale } = result.value;
  if (stale) return false;

  const headHashes = deps.headLockfileHashes;
  if (headHashes && Object.keys(headHashes).length > 0) {
    const snapshotByPath = new Map(
      snapshot.lockfiles.map((l) => [l.path, l.sha256] as const),
    );
    for (const [lockPath, headSha] of Object.entries(headHashes)) {
      if (snapshotByPath.get(lockPath) !== headSha) return false;
    }
  }
  return true;
}
