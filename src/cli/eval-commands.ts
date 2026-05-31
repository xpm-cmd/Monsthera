/* eslint-disable no-console */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFlag, withContainer } from "./arg-helpers.js";
import { printSubcommandHelp, wantsHelp } from "./help.js";
import { loadGoldenCases } from "../eval/golden.js";
import { runEval, type EvalReport, type EvalTarget } from "../eval/harness.js";

/**
 * `monsthera eval` — run the retrieval-quality harness (C1) over the golden
 * set and print P@k / R@k / NDCG@k / MRR. A measurement tool for contributors
 * and CI; it reads golden cases from `tests/eval/golden/` (repo-only). With
 * `--baseline <file>` it prints deltas vs a committed baseline (report-only:
 * exit code stays 0 — gating is a later milestone).
 */
export async function handleEval(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    printSubcommandHelp({
      command: "monsthera eval",
      summary: "Score retrieval quality (P@k, R@k, NDCG@k, MRR) over the golden set.",
      usage: "[--target pack|search] [--k <n>] [--golden <dir>] [--baseline <file>] [--json] [--repo <path>]",
      flags: [
        { name: "--target <t>", description: "pack (build_context_pack) | search. Default: pack." },
        { name: "--k <n>", description: "Cutoff for P@k / R@k / NDCG@k. Default: 5." },
        { name: "--golden <dir>", description: "Golden-set dir. Default: <repo>/tests/eval/golden." },
        { name: "--baseline <file>", description: "Print aggregate deltas vs this baseline JSON (non-gating)." },
        { name: "--json", description: "Emit the raw report as JSON." },
        { name: "--repo, -r <path>", description: "Repository path.", default: "cwd" },
      ],
    });
    return;
  }

  const target = (parseFlag(args, "--target") ?? "pack") as EvalTarget;
  if (target !== "pack" && target !== "search") {
    console.error(`Invalid --target "${target}" (expected pack|search).`);
    process.exit(1);
  }
  const kRaw = parseFlag(args, "--k");
  const k = kRaw !== undefined ? Number(kRaw) : 5;
  if (!Number.isInteger(k) || k < 1) {
    console.error(`Invalid --k "${kRaw}" (expected a positive integer).`);
    process.exit(1);
  }
  const asJson = args.includes("--json");
  const baselinePath = parseFlag(args, "--baseline");

  await withContainer(args, async (container) => {
    const goldenDir = parseFlag(args, "--golden") ?? path.join(container.config.repoPath, "tests/eval/golden");
    let cases;
    try {
      cases = loadGoldenCases(goldenDir);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
      return;
    }
    if (cases.length === 0) {
      console.error(`No golden cases found in ${goldenDir}.`);
      process.exit(1);
      return;
    }

    const report = await runEval({ provider: container.searchService, cases, target, k });
    const semanticEnabled = container.config.search.semanticEnabled;

    if (asJson) {
      process.stdout.write(JSON.stringify({ ...report, semanticEnabled }, null, 2) + "\n");
    } else {
      process.stdout.write(renderReport(report, semanticEnabled) + "\n");
    }

    if (baselinePath !== undefined) {
      printBaselineDeltas(report, baselinePath);
    }
  });
}

function renderReport(report: EvalReport, semanticEnabled: boolean): string {
  const lines: string[] = [];
  lines.push(
    `Eval — target=${report.target} k=${report.k} cases=${report.caseCount} ` +
      `semantic=${semanticEnabled ? "on" : "off"}`,
  );
  lines.push("");
  for (const c of report.cases) {
    const flag = c.error !== undefined ? ` ERROR(${c.error})` : "";
    lines.push(
      `  P@k=${c.precision.toFixed(3)} R@k=${c.recall.toFixed(3)} ` +
        `NDCG=${c.ndcg.toFixed(3)} RR=${c.reciprocalRank.toFixed(3)}  ${c.query}${flag}`,
    );
  }
  lines.push("");
  const a = report.aggregate;
  lines.push(
    `AGGREGATE  P@${report.k}=${a.precisionAtK.toFixed(4)} R@${report.k}=${a.recallAtK.toFixed(4)} ` +
      `NDCG@${report.k}=${a.ndcgAtK.toFixed(4)} MRR=${a.mrr.toFixed(4)}`,
  );
  return lines.join("\n");
}

function printBaselineDeltas(report: EvalReport, baselinePath: string): void {
  let baseline: { aggregate?: EvalReport["aggregate"] };
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
  } catch (e) {
    console.error(`Could not read baseline ${baselinePath}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const base = baseline.aggregate;
  if (base === undefined) {
    console.error(`Baseline ${baselinePath} has no "aggregate" field; skipping comparison.`);
    return;
  }
  const fmt = (cur: number, prev: number): string => {
    const d = cur - prev;
    const sign = d > 0 ? "+" : "";
    return `${cur.toFixed(4)} (${sign}${d.toFixed(4)} vs ${prev.toFixed(4)})`;
  };
  const a = report.aggregate;
  process.stdout.write("\nvs baseline:\n");
  process.stdout.write(`  P@${report.k}=${fmt(a.precisionAtK, base.precisionAtK)}\n`);
  process.stdout.write(`  R@${report.k}=${fmt(a.recallAtK, base.recallAtK)}\n`);
  process.stdout.write(`  NDCG@${report.k}=${fmt(a.ndcgAtK, base.ndcgAtK)}\n`);
  process.stdout.write(`  MRR=${fmt(a.mrr, base.mrr)}\n`);
}
