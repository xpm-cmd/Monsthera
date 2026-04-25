import type { WorkArticle } from "./repository.js";
import type { SnapshotService } from "../context/snapshot-service.js";
import type { CanonicalValue, Policy } from "./policy-loader.js";
import type { WorkPhase } from "../core/types.js";

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

// ─── Canonical-Values Guards ───

/**
 * Window (in characters) after each name occurrence in which we look for a
 * numeric token. Wide enough to span "c_rt = $0.010" or "c_rt is around
 * $0.010" or a markdown table cell; narrow enough to avoid stealing a number
 * from an unrelated paragraph.
 */
const CANONICAL_VALUE_NUMBER_WINDOW = 80;

/** Structured violation used by lint output + readiness reports. */
export interface CanonicalValueViolation {
  readonly name: string;
  readonly expected: string;
  readonly found: string;
  readonly lineHint: string;
}

export interface CanonicalValueGuardContext {
  readonly canonicalValues: readonly CanonicalValue[];
}

/**
 * Return true iff every canonical value referenced in the article body carries
 * the expected numeric. Silent on names the article does not mention — a value
 * registry can be large while any single article only touches a handful.
 */
export function content_matches_canonical_values(
  article: WorkArticle,
  context: CanonicalValueGuardContext,
): boolean {
  return getCanonicalValueViolations(article, context.canonicalValues).length === 0;
}

/**
 * Pure helper consumed by both the guard and the lint CLI. Accepts any input
 * with a `content` string so knowledge articles (which lack the broader
 * `WorkArticle` shape) can flow through the same code path.
 *
 * Heuristic:
 *   - For each canonical value `cv`, find word-bounded occurrences of `cv.name`.
 *   - Within the following `CANONICAL_VALUE_NUMBER_WINDOW` characters, extract
 *     the first numeric token (optional `$`, digits, optional comma-separated
 *     thousands, optional decimal).
 *   - Compare normalised forms (strip `$`, `,`, whitespace). A raw-string
 *     compare is deliberate — float parsing would mask drift like "0.010" vs
 *     "0.01" that auditors care about.
 *
 * When `cv.name` is mentioned without any nearby number, the occurrence is
 * treated as descriptive and skipped. When the numbers match, no violation is
 * emitted. Only a true mismatch surfaces.
 */
export function getCanonicalValueViolations(
  article: { readonly content: string },
  canonicalValues: readonly CanonicalValue[],
): readonly CanonicalValueViolation[] {
  if (canonicalValues.length === 0) return [];

  const violations: CanonicalValueViolation[] = [];

  for (const cv of canonicalValues) {
    const expectedNormalised = normaliseNumericToken(cv.value);
    const nameEscaped = cv.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = new RegExp(
      `\\b${nameEscaped}\\b([\\s\\S]{0,${CANONICAL_VALUE_NUMBER_WINDOW}}?)(\\$?-?\\d[\\d,]*(?:\\.\\d+)?)`,
      "g",
    );

    for (const match of article.content.matchAll(matcher)) {
      const found = match[2] ?? "";
      if (normaliseNumericToken(found) === expectedNormalised) continue;

      violations.push({
        name: cv.name,
        expected: cv.value,
        found,
        lineHint: extractLine(article.content, match.index ?? 0),
      });
    }
  }

  return violations;
}

function normaliseNumericToken(raw: string): string {
  return raw.replace(/[$,\s]/g, "").trim();
}

function extractLine(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const lineEnd = text.indexOf("\n", index);
  return text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
}

// ─── Convoy Guards (ADR-009) ───

/**
 * Per-call context for `convoy_lead_ready`. The orchestrator pre-resolves
 * the convoy lead's current phase and passes the template's phase ordering
 * (so `targetPhase` comparison is graph-aware, not string-comparison-based).
 * Keeping the guard pure preserves its testability and the AGENTS.md §6
 * "no I/O in guards" invariant.
 */
export interface ConvoyGuardContext {
  readonly leadPhase: WorkPhase;
  readonly targetPhase: WorkPhase;
  /** Ordered list of phases for the lead's template, lowest index = earliest. */
  readonly phaseOrder: readonly WorkPhase[];
}

/**
 * Returns true iff the convoy lead's current phase is at-or-past the
 * convoy's `targetPhase` per the lead's template `phaseOrder`. Members
 * stay blocked until the lead reaches the target — this is the "lead
 * unblocks the convoy" semantics from ADR-004 made executable.
 *
 * Phase comparison goes through the template's `phaseOrder` rather than
 * string comparison: spike templates skip phases, so alphabetic ordering
 * would lie. Returns false for unknown phases (fail-closed).
 */
export function convoy_lead_ready(
  _article: WorkArticle,
  context: ConvoyGuardContext,
): boolean {
  const leadIdx = context.phaseOrder.indexOf(context.leadPhase);
  const targetIdx = context.phaseOrder.indexOf(context.targetPhase);
  if (leadIdx < 0 || targetIdx < 0) return false;
  return leadIdx >= targetIdx;
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
