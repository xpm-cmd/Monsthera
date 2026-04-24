/* eslint-disable no-console */
import * as path from "node:path";
import { PolicyLoader } from "../work/policy-loader.js";
import { scanCorpus } from "../work/lint.js";
import type { LintFinding, LintInclude } from "../work/lint.js";
import { parseFlag, withContainer } from "./arg-helpers.js";
import { printSubcommandHelp, wantsHelp } from "./help.js";

/**
 * `monsthera lint` — scan the corpus for canonical-value drift (and, once
 * Part 2 lands, orphan citations). JSON-lines on stdout by default so the
 * output is pipe-friendly; logs stay on stderr through the shared logger.
 * Exit code 1 when any `severity: error` finding is produced.
 */
export async function handleLint(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera lint",
      summary: "Audit the knowledge and work corpus for canonical-value drift.",
      usage: "[--include knowledge|work|both] [--format json|text] [--repo <path>]",
      flags: [
        {
          name: "--include <set>",
          description: "Which article kinds to scan. Default: both.",
        },
        {
          name: "--format <fmt>",
          description: "json (NDJSON, default) or text (human-readable).",
        },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
      notes: [
        "Exit code 1 when any canonical_value_mismatch is found; 0 otherwise.",
        "Orphan citations (if present in later versions) are warnings and do not affect exit code.",
      ],
      examples: [
        "monsthera lint",
        "monsthera lint --include knowledge --format text",
      ],
    });
    return;
  }

  const include = (parseFlag(args, "--include") as LintInclude | undefined) ?? "both";
  const format = parseFlag(args, "--format") ?? "json";

  if (!["knowledge", "work", "both"].includes(include)) {
    console.error(`Invalid --include "${include}" (expected knowledge|work|both).`);
    process.exit(1);
  }
  if (!["json", "text"].includes(format)) {
    console.error(`Invalid --format "${format}" (expected json|text).`);
    process.exit(1);
  }

  await withContainer(args, async (container) => {
    const markdownRoot = path.resolve(
      container.config.repoPath,
      container.config.storage.markdownRoot,
    );

    const policyLoader = new PolicyLoader({
      knowledgeRepo: container.knowledgeRepo,
      logger: container.logger,
    });
    const canonicalValues = await policyLoader.getCanonicalValues();

    const result = await scanCorpus({
      markdownRoot,
      include,
      canonicalValues,
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

function formatFindingsTable(findings: readonly LintFinding[]): string {
  if (findings.length === 0) return "No findings.";
  const lines: string[] = [];
  for (const f of findings) {
    if (f.rule === "canonical_value_mismatch") {
      const since = f.sinceCommit ? ` (since ${f.sinceCommit})` : "";
      lines.push(
        `${f.severity.toUpperCase()} ${f.file}: ${f.name} expected ${f.expected}, found ${f.found}${since} — ${f.lineHint}`,
      );
    } else {
      lines.push(
        `${f.severity.toUpperCase()} ${f.file}: orphan citation ${f.missingRefId} from ${f.sourceArticleId}`,
      );
    }
  }
  return lines.join("\n");
}
