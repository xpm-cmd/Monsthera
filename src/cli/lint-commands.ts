/* eslint-disable no-console */
import * as path from "node:path";
import type { MonstheraContainer } from "../core/container.js";
import { PolicyLoader } from "../work/policy-loader.js";
import type { CanonicalValue } from "../work/policy-loader.js";
import { DEFAULT_VERIFY_DENSITY_THRESHOLD, scanCorpus } from "../work/lint.js";
import type {
  CitationValueMismatchFinding,
  ContradictionLintFinding,
  LintFinding,
  LintInclude,
  LintRegistry,
  OrphanCitationFinding,
} from "../work/lint.js";
import { parseFlag, withContainer } from "./arg-helpers.js";
import { printSubcommandHelp, wantsHelp } from "./help.js";

const VALID_REGISTRIES: readonly LintRegistry[] = [
  "canonical-values",
  "anti-examples",
  "planning-hash",
  "tag-hygiene",
  "contradictions",
  "custom-frontmatter",
  "all",
];

/**
 * `monsthera lint` — scan the corpus for canonical-value drift,
 * token-level anti-example drift, phrase-level anti-examples, and
 * orphan citations. JSON-lines on stdout by default so the output is
 * pipe-friendly; logs stay on stderr through the shared logger. Exit
 * code 1 when any `severity: error` finding is produced.
 */
export async function handleLint(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera lint",
      summary:
        "Audit the knowledge + work corpus for canonical-value drift, anti-example drift, planning-section drift, and orphan citations.",
      usage:
        "[--include knowledge|work|both] [--registry canonical-values|anti-examples|planning-hash|all] [--format json|text] [--repo <path>]",
      flags: [
        {
          name: "--include <set>",
          description: "Which article kinds to scan. Default: both.",
        },
        {
          name: "--registry <name>",
          description:
            "Which registry family to apply: canonical-values, anti-examples, planning-hash, tag-hygiene, contradictions, custom-frontmatter, or all (default).",
        },
        {
          name: "--with-citation-values",
          description:
            "Also verify every citation-with-number pair against the cited article. Opt-in because O(N*M) in citation pairs.",
        },
        {
          name: "--verify-density-threshold <n>",
          description:
            "Override the `[verify]`-density warning threshold (default 0.20, or whatever a policy article pins). Disable by passing `off`.",
        },
        {
          name: "--format <fmt>",
          description: "json (NDJSON, default) or text (human-readable).",
        },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      notes: [
        "Exit code 1 when any canonical_value_mismatch, token_drift, phrase_anti_example, citation_value_mismatch, or planning_section_tampered is found; 0 otherwise.",
        "Orphan citations, verify_density_exceeded, and tag_near_duplicate are warnings and do not affect exit code.",
      ],
      examples: [
        "monsthera lint",
        "monsthera lint --include knowledge --format text",
        "monsthera lint --registry anti-examples",
        "monsthera lint --registry planning-hash",
        "monsthera lint --registry contradictions",
        "monsthera lint --registry custom-frontmatter",
        "monsthera lint --with-citation-values",
      ],
    });
    return;
  }

  const include = (parseFlag(args, "--include") as LintInclude | undefined) ?? "both";
  const registry = (parseFlag(args, "--registry") as LintRegistry | undefined) ?? "all";
  const format = parseFlag(args, "--format") ?? "json";
  const withCitationValues = args.includes("--with-citation-values");
  const verifyDensityFlag = parseFlag(args, "--verify-density-threshold");
  const verifyDensityOff = verifyDensityFlag === "off";
  const verifyDensityOverride =
    verifyDensityFlag !== undefined && !verifyDensityOff ? Number(verifyDensityFlag) : undefined;
  if (
    verifyDensityOverride !== undefined &&
    (!Number.isFinite(verifyDensityOverride) || verifyDensityOverride <= 0 || verifyDensityOverride > 1)
  ) {
    console.error(
      `Invalid --verify-density-threshold "${verifyDensityFlag}" (expected a number in (0,1] or "off").`,
    );
    process.exit(1);
  }

  if (!["knowledge", "work", "both"].includes(include)) {
    console.error(`Invalid --include "${include}" (expected knowledge|work|both).`);
    process.exit(1);
  }
  if (!VALID_REGISTRIES.includes(registry)) {
    console.error(
      `Invalid --registry "${registry}" (expected ${VALID_REGISTRIES.join("|")}).`,
    );
    process.exit(1);
  }
  if (!["json", "text"].includes(format)) {
    console.error(`Invalid --format "${format}" (expected json|text).`);
    process.exit(1);
  }

  await withContainer(args, async (container) => {
    const repoRoot = container.config.repoPath;
    const markdownRoot = path.resolve(repoRoot, container.config.storage.markdownRoot);

    const policyLoader = new PolicyLoader({
      knowledgeRepo: container.knowledgeRepo,
      logger: container.logger,
    });
    const [canonicalValues, antiExampleTokens, antiExamplePhrases, policyDensityThreshold, customFrontmatterRules] =
      await Promise.all([
        policyLoader.getCanonicalValues(),
        policyLoader.getAntiExampleTokens(),
        policyLoader.getAntiExamplePhrases(),
        policyLoader.getMaxVerifyDensity(),
        policyLoader.getCustomFrontmatterRules(),
      ]);

    const verifyDensityThreshold = verifyDensityOff
      ? undefined
      : (verifyDensityOverride ?? policyDensityThreshold ?? DEFAULT_VERIFY_DENSITY_THRESHOLD);

    const orphansResult = await container.structureService.getOrphanCitations();
    const orphanFindings: OrphanCitationFinding[] = orphansResult.ok
      ? orphansResult.value.map((o) => ({
          file: o.sourcePath ?? "",
          severity: "warning" as const,
          rule: "orphan_citation" as const,
          sourceArticleId: o.sourceArticleId,
          missingRefId: o.missingRefId,
        }))
      : [];

    const citationValueFindings = withCitationValues
      ? await collectCitationValueFindings(container)
      : [];

    const runContradictions = registry === "all" || registry === "contradictions";
    const contradictionFindings = runContradictions
      ? await collectContradictionFindings(container, canonicalValues)
      : [];

    const result = await scanCorpus({
      markdownRoot,
      include,
      registry,
      repoRoot,
      canonicalValues,
      antiExampleTokens,
      antiExamplePhrases,
      orphanFindings,
      citationValueFindings,
      contradictionFindings,
      customFrontmatterRules,
      ...(verifyDensityThreshold !== undefined ? { verifyDensityThreshold } : {}),
    });

    if (format === "json") {
      for (const finding of result.findings) {
        process.stdout.write(JSON.stringify(finding) + "\n");
      }
    } else {
      process.stdout.write(formatFindingsTable(result.findings) + "\n");
    }

    if (result.errorCount > 0) {
      process.exit(1);
    }
  });
}

/**
 * Iterate every knowledge + work article and collect citation-value
 * mismatches as lint findings. The `file` field uses the same
 * markdown-root-relative form as the scanner's other findings
 * (`notes/<slug>.md` / `work-articles/<id>.md`) so the CLI output
 * stays consistent regardless of which rule produced each line.
 */
async function collectCitationValueFindings(
  container: MonstheraContainer,
): Promise<readonly CitationValueMismatchFinding[]> {
  const [knowledge, work] = await Promise.all([
    container.knowledgeRepo.findMany(),
    container.workRepo.findMany(),
  ]);
  const findings: CitationValueMismatchFinding[] = [];

  if (knowledge.ok) {
    for (const a of knowledge.value) {
      const res = await container.structureService.verifyCitedValues(a.id);
      if (!res.ok) continue;
      const file = path.join("notes", `${a.slug}.md`);
      for (const v of res.value) {
        findings.push({
          file,
          severity: "error",
          rule: "citation_value_mismatch",
          sourceArticle: v.sourceArticle,
          citedArticle: v.citedArticle,
          claimedValue: v.claimedValue,
          foundValues: v.foundValues,
          lineHint: v.lineHint,
        });
      }
    }
  }
  if (work.ok) {
    for (const a of work.value) {
      const res = await container.structureService.verifyCitedValues(a.id);
      if (!res.ok) continue;
      const file = path.join("work-articles", `${a.id}.md`);
      for (const v of res.value) {
        findings.push({
          file,
          severity: "error",
          rule: "citation_value_mismatch",
          sourceArticle: v.sourceArticle,
          citedArticle: v.citedArticle,
          claimedValue: v.claimedValue,
          foundValues: v.foundValues,
          lineHint: v.lineHint,
        });
      }
    }
  }
  return findings;
}

/**
 * Compute cross-article contradictions via `StructureService` and map them
 * into lint findings. `file` resolves to `articleA`'s markdown-root-relative
 * path so the CLI output stays consistent with every other rule.
 */
async function collectContradictionFindings(
  container: MonstheraContainer,
  canonicalValues: readonly CanonicalValue[],
): Promise<readonly ContradictionLintFinding[]> {
  const result = await container.structureService.detectContradictions(canonicalValues);
  if (!result.ok) return [];

  const [knowledge, work] = await Promise.all([
    container.knowledgeRepo.findMany(),
    container.workRepo.findMany(),
  ]);
  const fileById = new Map<string, string>();
  if (knowledge.ok) {
    for (const a of knowledge.value) fileById.set(a.id, path.join("notes", `${a.slug}.md`));
  }
  if (work.ok) {
    for (const a of work.value) fileById.set(a.id, path.join("work-articles", `${a.id}.md`));
  }

  return result.value.map((c) => ({
    file: fileById.get(c.articleA) ?? "",
    severity: "warning" as const,
    rule: "contradiction" as const,
    articleA: c.articleA,
    articleB: c.articleB,
    name: c.name,
    valueA: c.valueA,
    valueB: c.valueB,
    sharedVia: c.sharedVia,
    sharedKey: c.sharedKey,
  }));
}

function formatFindingsTable(findings: readonly LintFinding[]): string {
  if (findings.length === 0) return "No findings.";
  const lines: string[] = [];
  for (const f of findings) {
    lines.push(formatFinding(f));
  }
  return lines.join("\n");
}

function formatFinding(f: LintFinding): string {
  const prefix = `${f.severity.toUpperCase()} ${f.file}`;
  switch (f.rule) {
    case "canonical_value_mismatch": {
      const since = f.sinceCommit ? ` (since ${f.sinceCommit})` : "";
      return `${prefix}: ${f.name} expected ${f.expected}, found ${f.found}${since} — ${f.lineHint}`;
    }
    case "orphan_citation":
      return `${prefix}: orphan citation ${f.missingRefId} from ${f.sourceArticleId}`;
    case "token_drift": {
      const hint = f.suggestion ? ` (did you mean ${f.suggestion}?)` : "";
      return `${prefix}: token drift "${f.token}" (pattern ${f.pattern})${hint} — ${f.lineHint}`;
    }
    case "phrase_anti_example": {
      const since = f.sinceCommit ? ` (since ${f.sinceCommit})` : "";
      return `${prefix}: anti-example "${f.phrase}" — use "${f.corrected}"${since} — ${f.lineHint}`;
    }
    case "citation_value_mismatch": {
      const sample = f.foundValues.slice(0, 3).join(", ") || "(none)";
      return `${prefix}: cited ${f.citedArticle} claims ${f.claimedValue}, target has ${sample} — ${f.lineHint}`;
    }
    case "verify_density_exceeded": {
      const pct = `${f.densityPercent}%`;
      const thr = `${Math.round(f.threshold * 1000) / 10}%`;
      return `${prefix}: [verify]-density ${pct} (${f.verifyCount} markers / ${f.citationCount} citations) exceeds ${thr}`;
    }
    case "planning_section_tampered": {
      const expected = f.expectedHash.slice(0, 8);
      const actual = f.actualHash ? f.actualHash.slice(0, 8) : "(missing)";
      return `${prefix}: planning section drift on ${f.articleId} (phase=${f.phase}, expected=${expected}, actual=${actual})`;
    }
    case "tag_near_duplicate": {
      const variants = f.variants.map((v) => JSON.stringify(v)).join(", ");
      return `${prefix}: tag near-duplicate "${f.normalized}" — variants ${variants}`;
    }
    case "contradiction": {
      const via = f.sharedVia === "shared_tag" ? `tag ${f.sharedKey}` : `code ${f.sharedKey}`;
      return `${prefix}: contradiction on "${f.name}" — ${f.articleA}=${f.valueA} vs ${f.articleB}=${f.valueB} (shared ${via})`;
    }
    case "custom_frontmatter_violation":
      return `${prefix}: custom-frontmatter ${f.problem} — "${f.key}" (${f.articleCategory}): ${f.detail}`;
  }
}
