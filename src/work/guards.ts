import type { WorkArticle } from "./repository.js";
import type { SnapshotService } from "../context/snapshot-service.js";

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
