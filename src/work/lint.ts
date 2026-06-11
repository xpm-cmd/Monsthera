import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseMarkdown } from "../knowledge/markdown.js";
import type { AntiExamplePhrase, AntiExampleToken, CanonicalValue, CustomFrontmatterRule } from "./policy-loader.js";
import { resolveTokenContexts, scanPhraseAntiExamples, scanTokenDrift } from "./rules/anti-examples.js";
import { scanCanonicalValues } from "./rules/canonical-values.js";
import { scanCustomFrontmatter } from "./rules/custom-frontmatter.js";
import { scanPlanningHash } from "./rules/planning-hash.js";
import { scanTagNearDuplicates } from "./rules/tag-hygiene.js";
import { scanVerifyDensity } from "./rules/verify-density.js";

// Re-exported so the public import surface of `work/lint.js` is unchanged by
// the rules/ split — consumers keep importing the threshold from this module.
export { DEFAULT_VERIFY_DENSITY_THRESHOLD } from "./rules/verify-density.js";

/**
 * Finding shape emitted by `scanCorpus`. Kept as a discriminated union on
 * `rule` so additional rules can join without growing the top-level surface.
 * The `file` path is relative to the scanned markdown root — absolute paths
 * would leak /tmp details into the dashboard/CLI output.
 */
export type CanonicalValueMismatchFinding = {
  readonly file: string;
  readonly severity: "error";
  readonly rule: "canonical_value_mismatch";
  readonly name: string;
  readonly expected: string;
  readonly found: string;
  readonly lineHint: string;
  readonly sinceCommit?: string;
};

export type OrphanCitationFinding = {
  readonly file: string;
  readonly severity: "warning";
  readonly rule: "orphan_citation";
  readonly sourceArticleId: string;
  readonly missingRefId: string;
};

/**
 * Token-drift finding: a prose occurrence matched an anti-example-token
 * `pattern` but the matched string is not one of the canonical names
 * found under `canonicalSource`. `suggestion` carries the closest
 * canonical name by Levenshtein distance when one is within a reasonable
 * edit budget.
 */
export type TokenDriftFinding = {
  readonly file: string;
  readonly severity: "error";
  readonly rule: "token_drift";
  readonly token: string;
  readonly pattern: string;
  readonly canonicalSource: string;
  readonly lineHint: string;
  readonly suggestion?: string;
};

/**
 * Phrase anti-example finding: a prose occurrence exact-matched (case
 * insensitive) a registered wrong-form string. Lines carrying forward-
 * guard markers (`do NOT`, `anti-example`, `stale`, `<!-- anti-example
 * -->`) are skipped upstream so the registry article itself does not
 * self-flag.
 */
export type PhraseAntiExampleFinding = {
  readonly file: string;
  readonly severity: "error";
  readonly rule: "phrase_anti_example";
  readonly phrase: string;
  readonly corrected: string;
  readonly lineHint: string;
  readonly sinceCommit?: string;
};

/**
 * Citation-value mismatch finding: a citation-with-number in source
 * prose whose claimed value does not appear in the cited article's
 * content. Produced outside the scanner (by `StructureService
 * .verifyCitedValues`) and merged into the findings list when the
 * caller opts in via `--with-citation-values`. Default off because
 * the cost is O(N*M) in citation pairs.
 */
export type CitationValueMismatchFinding = {
  readonly file: string;
  readonly severity: "error";
  readonly rule: "citation_value_mismatch";
  readonly sourceArticle: string;
  readonly citedArticle: string;
  readonly claimedValue: string;
  readonly foundValues: readonly string[];
  readonly lineHint: string;
};

/**
 * Verify-density finding: the article carries more `[verify]`-family
 * markers than the threshold of outgoing citations, which is a signal
 * that unchecked verification has drifted out of proportion with the
 * claims it was meant to gate. Warning, not error — density is an
 * early-warning signal about review debt, not a correctness failure.
 */
export type VerifyDensityFinding = {
  readonly file: string;
  readonly severity: "warning";
  readonly rule: "verify_density_exceeded";
  readonly citationCount: number;
  readonly verifyCount: number;
  readonly densityPercent: number;
  readonly threshold: number;
  readonly oldestMarker?: { readonly line: string };
};

/**
 * Planning-section drift finding: a work article advanced past `planning`
 * carries a `planning_hash` captured at the time of that transition, and
 * the current `## Planning` section content no longer matches. Surfaces
 * silent post-planning edits, the most common drift vector identified
 * by the Hedera v1 retrospective. Always opt-in via `--registry all` or
 * `--registry planning-hash`; relevant only to work articles, never to
 * knowledge notes.
 */
export type PlanningSectionTamperedFinding = {
  readonly file: string;
  readonly severity: "error";
  readonly rule: "planning_section_tampered";
  readonly articleId: string;
  readonly phase: string;
  readonly expectedHash: string;
  readonly actualHash: string | null;
};

/**
 * Tag near-duplicate finding: an article's frontmatter `tags` contains 2+ raw
 * entries that collapse to the same normalized key (differing by surrounding
 * quotes, case, or whitespace — or exact duplicates). Warning, not error:
 * this is corpus hygiene, not a correctness failure, and must not gate the
 * `monsthera lint` exit code that the pre-commit hook depends on. The write
 * path (normalizeTags in schemas.ts) prevents NEW dirty tags; this rule
 * surfaces the historical backlog already on disk.
 */
export type TagNearDuplicateFinding = {
  readonly file: string;
  readonly severity: "warning";
  readonly rule: "tag_near_duplicate";
  readonly normalized: string;
  readonly variants: readonly string[];
};

/**
 * Cross-article contradiction: two graph-adjacent articles (sharing a tag
 * or a code ref) state different values for the same canonical name.
 * Warning, not error — disagreement between notes is a review signal, not a
 * build-breaking failure, and must not gate the pre-commit lint exit code.
 * Produced by `StructureService.detectContradictions` and merged in when the
 * `contradictions` registry family is active. `file` is the markdown-root-
 * relative path of `articleA`.
 */
export type ContradictionLintFinding = {
  readonly file: string;
  readonly severity: "warning";
  readonly rule: "contradiction";
  readonly articleA: string;
  readonly articleB: string;
  readonly name: string;
  readonly valueA: string;
  readonly valueB: string;
  readonly sharedVia: "shared_tag" | "code_ref";
  readonly sharedKey: string;
};

/**
 * Custom-frontmatter policy violation (PR-14b, ADR-020 P3): an article's custom
 * frontmatter does not satisfy a `CustomFrontmatterRule` declared for its
 * category — a required field is missing, a field is the wrong scalar type, or
 * a numeric field is out of range. Severity defaults to `warning` (corpus
 * hygiene, does not gate pre-commit) but a policy rule may raise it to `error`.
 */
export type CustomFrontmatterFinding = {
  readonly file: string;
  readonly severity: "warning" | "error";
  readonly rule: "custom_frontmatter_violation";
  readonly articleCategory: string;
  readonly key: string;
  readonly problem: "missing_required" | "wrong_type" | "out_of_range";
  readonly detail: string;
};

export type LintFinding =
  | CanonicalValueMismatchFinding
  | ContradictionLintFinding
  | OrphanCitationFinding
  | TokenDriftFinding
  | PhraseAntiExampleFinding
  | CitationValueMismatchFinding
  | VerifyDensityFinding
  | PlanningSectionTamperedFinding
  | TagNearDuplicateFinding
  | CustomFrontmatterFinding;

export type LintInclude = "knowledge" | "work" | "both";

/** Which registry families are active during a scan. */
export type LintRegistry =
  | "canonical-values"
  | "anti-examples"
  | "planning-hash"
  | "tag-hygiene"
  | "contradictions"
  | "custom-frontmatter"
  | "all";

export interface LintScanInput {
  readonly markdownRoot: string;
  readonly include?: LintInclude;
  readonly registry?: LintRegistry;
  readonly canonicalValues: readonly CanonicalValue[];
  readonly antiExampleTokens?: readonly AntiExampleToken[];
  readonly antiExamplePhrases?: readonly AntiExamplePhrase[];
  /**
   * Repository root used to resolve `canonicalSource` globs. When absent,
   * token-drift rules cannot build their canonical-name sets so the rule
   * silently skips — the scanner does not fail merely because a consumer
   * has not wired `repoRoot` through yet.
   */
  readonly repoRoot?: string;
  /**
   * Orphan findings produced elsewhere (e.g. `StructureService.getOrphanCitations`)
   * and merged into the returned list. The scanner itself does not compute
   * them — orphan resolution needs the full article graph, which lives in
   * `StructureService`, not in the filesystem scan.
   */
  readonly orphanFindings?: readonly OrphanCitationFinding[];
  /**
   * Citation-value mismatches produced elsewhere (by iterating
   * `StructureService.verifyCitedValues` over every article). Merged as
   * errors. Absent by default — the `--with-citation-values` CLI flag
   * opts in because the cost is O(N*M) in citation pairs.
   */
  readonly citationValueFindings?: readonly CitationValueMismatchFinding[];
  /**
   * Threshold at which `[verify]`-density exceeds acceptable review
   * debt. When `undefined` the check is skipped entirely; when a number
   * (e.g. 0.20 = 20%), articles with `verifyCount / citationCount >
   * threshold` emit a `verify_density_exceeded` warning.
   */
  readonly verifyDensityThreshold?: number;
  /**
   * Cross-article contradictions produced by
   * `StructureService.detectContradictions`. Merged as warnings when the
   * `contradictions` registry family is active. Absent by default — the CLI
   * computes them only under `--registry contradictions|all` to avoid the
   * graph + canonical-extraction cost on unrelated scans.
   */
  readonly contradictionFindings?: readonly ContradictionLintFinding[];
  /**
   * Per-category custom-frontmatter expectations (PR-14b), from
   * `PolicyLoader.getCustomFrontmatterRules`. Applied per-article when the
   * `custom-frontmatter` registry family is active. Absent/empty → the family
   * emits nothing, so the rule is inert until a policy declares expectations.
   */
  readonly customFrontmatterRules?: readonly CustomFrontmatterRule[];
}

export interface LintScanResult {
  readonly findings: readonly LintFinding[];
  readonly errorCount: number;
  readonly warningCount: number;
}

const NOTES_DIR = "notes";
const WORK_DIR = "work-articles";

/**
 * Articles tagged with one of these are intentional drift carriers — a
 * demo fixture or the design doc that DOCUMENTS the anti-examples — so the
 * content-drift rules (canonical-value + anti-example token/phrase) are
 * skipped for them. Without this, `monsthera lint` can never exit 0 on its
 * own corpus, which makes the `install-hook` pre-commit gate unusable.
 *
 * `drift-sample` is the pre-existing tag on the demo fixture; `lint-exempt`
 * is the explicit, self-documenting opt-out for any other article that must
 * embed a wrong-form string for documentation. Scoped to the registry
 * content rules only — planning-hash tamper detection still runs.
 */
const LINT_EXEMPT_TAGS: readonly string[] = ["lint-exempt", "drift-sample"];

/**
 * True when an article's frontmatter `tags` include any LINT_EXEMPT_TAGS
 * entry. Tolerates both the array form (`tags: [a, b]`) and a bare string,
 * since the lightweight frontmatter parser yields either depending on shape.
 */
function hasExemptTag(frontmatter: Record<string, unknown>): boolean {
  const raw = frontmatter["tags"];
  const tags = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return tags.some((tag) => typeof tag === "string" && LINT_EXEMPT_TAGS.includes(tag));
}

/**
 * Scan a markdown corpus for canonical-value drift, token drift,
 * phrase anti-examples, planning-section drift, and (optionally) merge
 * pre-computed orphan findings. Pure w.r.t. the repo graph — callers
 * supply the registries and any orphan set; the scanner owns file
 * traversal and the per-file heuristics.
 *
 * Registry filter (`input.registry`):
 * - `all` (default) — run every active family.
 * - `canonical-values` — only the canonical-value mismatch rule.
 * - `anti-examples` — only token drift + phrase anti-examples.
 * - `planning-hash` — only the planning-section-tampered rule (work only).
 *
 * `orphanFindings` are always passed through regardless of filter; they
 * are produced outside the scanner and the filter does not own them.
 */
export async function scanCorpus(input: LintScanInput): Promise<LintScanResult> {
  const include: LintInclude = input.include ?? "both";
  const registry: LintRegistry = input.registry ?? "all";
  const runCanonical = registry === "all" || registry === "canonical-values";
  const runAntiExamples = registry === "all" || registry === "anti-examples";
  const runPlanningHash = registry === "all" || registry === "planning-hash";
  const runTagHygiene = registry === "all" || registry === "tag-hygiene";
  const runContradictions = registry === "all" || registry === "contradictions";
  const runCustomFrontmatter = registry === "all" || registry === "custom-frontmatter";

  const findings: LintFinding[] = [];

  const customFrontmatterRules = runCustomFrontmatter ? (input.customFrontmatterRules ?? []) : [];

  const tokens = runAntiExamples ? (input.antiExampleTokens ?? []) : [];
  const phrases = runAntiExamples ? (input.antiExamplePhrases ?? []) : [];
  const tokenContexts = await resolveTokenContexts(tokens, input.repoRoot);

  const dirs: string[] = [];
  if (include === "knowledge" || include === "both") dirs.push(NOTES_DIR);
  if (include === "work" || include === "both") dirs.push(WORK_DIR);

  for (const dir of dirs) {
    const absDir = path.join(input.markdownRoot, dir);
    const files = await safeListMarkdown(absDir);
    for (const fileName of files) {
      const absFile = path.join(absDir, fileName);
      const raw = await fs.readFile(absFile, "utf-8").catch(() => null);
      if (raw === null) continue;

      const parsed = parseMarkdown(raw);
      if (!parsed.ok) continue;

      const body = parsed.value.body;
      const relFile = path.join(dir, fileName);

      // Intentional drift carriers (demo fixtures, the drift design doc)
      // opt out of the content-drift rules via a frontmatter tag; the
      // planning-hash tamper check below still applies.
      const isLintExempt = hasExemptTag(parsed.value.frontmatter);

      if (runCanonical && !isLintExempt) {
        findings.push(...scanCanonicalValues(body, relFile, input.canonicalValues));
      }

      if (runAntiExamples && !isLintExempt) {
        findings.push(...scanTokenDrift(body, relFile, tokenContexts));
        findings.push(...scanPhraseAntiExamples(body, relFile, phrases));
      }

      if (input.verifyDensityThreshold !== undefined) {
        const densityFinding = scanVerifyDensity(
          body,
          relFile,
          input.verifyDensityThreshold,
        );
        if (densityFinding) findings.push(densityFinding);
      }

      if (runPlanningHash && dir === WORK_DIR) {
        const tamper = scanPlanningHash(parsed.value.frontmatter, body, relFile);
        if (tamper) findings.push(tamper);
      }

      if (runTagHygiene && !isLintExempt) {
        findings.push(...scanTagNearDuplicates(parsed.value.frontmatter, relFile));
      }

      if (runCustomFrontmatter && customFrontmatterRules.length > 0) {
        findings.push(...scanCustomFrontmatter(parsed.value.frontmatter, customFrontmatterRules, relFile));
      }
    }
  }

  if (input.orphanFindings) findings.push(...input.orphanFindings);
  if (input.citationValueFindings) findings.push(...input.citationValueFindings);
  if (runContradictions && input.contradictionFindings) findings.push(...input.contradictionFindings);

  return {
    findings,
    errorCount: findings.filter((f) => f.severity === "error").length,
    warningCount: findings.filter((f) => f.severity === "warning").length,
  };
}

async function safeListMarkdown(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir);
    return entries.filter((e) => e.endsWith(".md")).sort();
  } catch {
    // Directory missing or unreadable — treat as empty corpus; lint should not
    // fail just because a repo has no work-articles yet.
    return [];
  }
}
