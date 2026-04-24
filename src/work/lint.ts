import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseMarkdown } from "../knowledge/markdown.js";
import { getCanonicalValueViolations } from "./guards.js";
import type { CanonicalValue } from "./policy-loader.js";

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

export type LintFinding = CanonicalValueMismatchFinding | OrphanCitationFinding;

export type LintInclude = "knowledge" | "work" | "both";

export interface LintScanInput {
  readonly markdownRoot: string;
  readonly include?: LintInclude;
  readonly canonicalValues: readonly CanonicalValue[];
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
 * Scan a markdown corpus for canonical-value drift and (optionally) merge
 * pre-computed orphan findings. Pure w.r.t. the repo graph — callers supply
 * the registry and any orphan set, the scanner only owns file traversal and
 * the per-file heuristic.
 */
export async function scanCorpus(input: LintScanInput): Promise<LintScanResult> {
  const include: LintInclude = input.include ?? "both";
  const findings: LintFinding[] = [];

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

      const violations = getCanonicalValueViolations(
        { content: parsed.value.body },
        input.canonicalValues,
      );

      for (const v of violations) {
        const source = findCanonicalValue(input.canonicalValues, v.name);
        findings.push({
          file: path.join(dir, fileName),
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
