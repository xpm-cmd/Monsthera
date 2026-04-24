import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseMarkdown } from "../knowledge/markdown.js";
import { getCanonicalValueViolations } from "./guards.js";
import type { AntiExamplePhrase, AntiExampleToken, CanonicalValue } from "./policy-loader.js";

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

export type LintFinding =
  | CanonicalValueMismatchFinding
  | OrphanCitationFinding
  | TokenDriftFinding
  | PhraseAntiExampleFinding;

export type LintInclude = "knowledge" | "work" | "both";

/** Which registry families are active during a scan. */
export type LintRegistry = "canonical-values" | "anti-examples" | "all";

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
}

export interface LintScanResult {
  readonly findings: readonly LintFinding[];
  readonly errorCount: number;
  readonly warningCount: number;
}

const NOTES_DIR = "notes";
const WORK_DIR = "work-articles";

/**
 * Scan a markdown corpus for canonical-value drift, token drift,
 * phrase anti-examples, and (optionally) merge pre-computed orphan
 * findings. Pure w.r.t. the repo graph — callers supply the registries
 * and any orphan set; the scanner owns file traversal and the per-file
 * heuristics.
 *
 * Registry filter (`input.registry`):
 * - `all` (default) — run every active family.
 * - `canonical-values` — only the canonical-value mismatch rule.
 * - `anti-examples` — only token drift + phrase anti-examples.
 *
 * `orphanFindings` are always passed through regardless of filter; they
 * are produced outside the scanner and the filter does not own them.
 */
export async function scanCorpus(input: LintScanInput): Promise<LintScanResult> {
  const include: LintInclude = input.include ?? "both";
  const registry: LintRegistry = input.registry ?? "all";
  const runCanonical = registry === "all" || registry === "canonical-values";
  const runAntiExamples = registry === "all" || registry === "anti-examples";

  const findings: LintFinding[] = [];

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

      if (runCanonical) {
        const violations = getCanonicalValueViolations(
          { content: body },
          input.canonicalValues,
        );

        for (const v of violations) {
          const source = findCanonicalValue(input.canonicalValues, v.name);
          findings.push({
            file: relFile,
            severity: "error",
            rule: "canonical_value_mismatch",
            name: v.name,
            expected: v.expected,
            found: v.found,
            lineHint: v.lineHint,
            ...(source?.validSinceCommit ? { sinceCommit: source.validSinceCommit } : {}),
          });
        }
      }

      if (runAntiExamples) {
        findings.push(...scanTokenDrift(body, relFile, tokenContexts));
        findings.push(...scanPhraseAntiExamples(body, relFile, phrases));
      }
    }
  }

  if (input.orphanFindings) findings.push(...input.orphanFindings);

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

function findCanonicalValue(
  values: readonly CanonicalValue[],
  name: string,
): CanonicalValue | undefined {
  return values.find((v) => v.name === name);
}

// ─── Anti-example matchers ────────────────────────────────────────────────

/**
 * Per-token state compiled once per scan. `canonical` is the set of
 * known-good tokens found in the canonical-source files (by running the
 * same `pattern` against them) — prose matches outside this set are drift.
 * `ready` is false when resolution is skipped (no `repoRoot` supplied, or
 * the pattern failed to compile); the scanner emits no findings for a
 * non-ready token rule.
 */
interface TokenContext {
  readonly rule: AntiExampleToken;
  readonly regex: RegExp;
  readonly canonical: ReadonlySet<string>;
  readonly ready: boolean;
}

/**
 * Any of these markers on a line excludes it from the phrase-anti-example
 * matcher so a registry article (which must quote the wrong form verbatim)
 * does not self-flag. Case-insensitive; whole-substring match on the line.
 */
const FORWARD_GUARD_MARKERS = [
  "do not",
  "anti-example",
  "anti example",
  "stale",
  "<!-- anti-example -->",
];

function lineHasForwardGuard(line: string): boolean {
  const lower = line.toLowerCase();
  return FORWARD_GUARD_MARKERS.some((m) => lower.includes(m));
}

function scanPhraseAntiExamples(
  body: string,
  file: string,
  phrases: readonly AntiExamplePhrase[],
): readonly PhraseAntiExampleFinding[] {
  if (phrases.length === 0) return [];

  const findings: PhraseAntiExampleFinding[] = [];
  const lines = body.split("\n");

  for (const phrase of phrases) {
    const needle = phrase.phrase.toLowerCase();
    for (const line of lines) {
      if (!line.toLowerCase().includes(needle)) continue;
      if (lineHasForwardGuard(line)) continue;

      findings.push({
        file,
        severity: "error",
        rule: "phrase_anti_example",
        phrase: phrase.phrase,
        corrected: phrase.corrected,
        lineHint: line.trim(),
        ...(phrase.sinceCommit ? { sinceCommit: phrase.sinceCommit } : {}),
      });
    }
  }

  return findings;
}

function scanTokenDrift(
  body: string,
  file: string,
  contexts: readonly TokenContext[],
): readonly TokenDriftFinding[] {
  if (contexts.length === 0) return [];

  const findings: TokenDriftFinding[] = [];

  for (const ctx of contexts) {
    if (!ctx.ready) continue;

    for (const match of body.matchAll(ctx.regex)) {
      const token = match[0];
      if (ctx.canonical.has(token)) continue;

      const suggestion = closestByLevenshtein(token, ctx.canonical);
      findings.push({
        file,
        severity: "error",
        rule: "token_drift",
        token,
        pattern: ctx.rule.pattern,
        canonicalSource: ctx.rule.canonicalSource,
        lineHint: extractLineForIndex(body, match.index ?? 0),
        ...(suggestion ? { suggestion } : {}),
      });
    }
  }

  return findings;
}

async function resolveTokenContexts(
  tokens: readonly AntiExampleToken[],
  repoRoot: string | undefined,
): Promise<readonly TokenContext[]> {
  if (tokens.length === 0) return [];

  const contexts: TokenContext[] = [];
  for (const rule of tokens) {
    const compiled = safeCompile(rule.pattern);
    if (!compiled) {
      contexts.push({ rule, regex: /$./g, canonical: new Set(), ready: false });
      continue;
    }

    if (!repoRoot) {
      contexts.push({ rule, regex: compiled, canonical: new Set(), ready: false });
      continue;
    }

    const canonical = await collectCanonicalTokens(rule.canonicalSource, repoRoot, compiled);
    contexts.push({ rule, regex: compiled, canonical, ready: true });
  }
  return contexts;
}

function safeCompile(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, "g");
  } catch {
    return undefined;
  }
}

/**
 * Build the canonical-name set for a token rule by running the same
 * pattern against the files matched by `sourceGlob` (relative to
 * `repoRoot`). Uses `fs.glob` (stable in Node 22+) so behaviour matches
 * the rest of the codebase that targets Node 22+.
 *
 * Any unreadable file is skipped silently — a missing canonical source
 * tree degrades to "no canonical names known", which means every prose
 * match would flag. That is usually the right signal (misconfigured
 * rule); the caller can always filter by `canonicalSource` in triage.
 */
async function collectCanonicalTokens(
  sourceGlob: string,
  repoRoot: string,
  regex: RegExp,
): Promise<ReadonlySet<string>> {
  const canonical = new Set<string>();
  const iterable = fs.glob(sourceGlob, { cwd: repoRoot });
  for await (const rel of iterable) {
    const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    const text = await fs.readFile(abs, "utf-8").catch(() => null);
    if (text === null) continue;
    for (const m of text.matchAll(regex)) {
      canonical.add(m[0]);
    }
  }
  return canonical;
}

function closestByLevenshtein(needle: string, candidates: ReadonlySet<string>): string | undefined {
  if (candidates.size === 0) return undefined;

  let best: string | undefined;
  let bestDist = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const d = levenshtein(needle, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }

  // Only suggest when the edit distance is within roughly half the
  // needle's length; beyond that the "suggestion" is more distracting
  // than helpful.
  if (best !== undefined && bestDist <= Math.max(2, Math.floor(needle.length / 2))) {
    return best;
  }
  return undefined;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j] ?? 0;
  }

  return prev[b.length] ?? 0;
}

function extractLineForIndex(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const lineEnd = text.indexOf("\n", index);
  return text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
}
