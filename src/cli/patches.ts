import { basename } from "node:path";
import { initDatabase } from "../db/init.js";
import * as queries from "../db/queries.js";
import { getHead, getMainRepoRoot, getRepoRoot, isGitRepo } from "../git/operations.js";
import type { InsightStream } from "../core/insight-stream.js";
import {
  buildPatchDetailPayload,
  buildPatchListPayload,
  buildPatchSummaryPayload,
  type PatchDetailPayload,
  type PatchListPayload,
  type PatchSummaryPayload,
} from "../patches/read-model.js";

export interface PatchCliConfig {
  repoPath: string;
  monstheraDir: string;
  dbName: string;
}

export async function cmdPatch(config: PatchCliConfig, insight: InsightStream, args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "help" || args.includes("--help") || args.includes("-h")) {
    printPatchHelp();
    return;
  }

  if (!(await isGitRepo({ cwd: config.repoPath }))) {
    insight.error("Not a git repository");
    process.exitCode = 1;
    return;
  }

  const repoRoot = await getRepoRoot({ cwd: config.repoPath });
  const mainRepoRoot = await getMainRepoRoot({ cwd: config.repoPath });
  const currentHead = await getHead({ cwd: repoRoot });
  const repoName = basename(repoRoot);
  const { db, sqlite } = initDatabase({ repoPath: mainRepoRoot, monstheraDir: config.monstheraDir, dbName: config.dbName });
  const { id: repoId } = queries.upsertRepo(db, repoRoot, repoName);

  try {
    switch (subcommand) {
      case "summary":
        printOutput(
          buildLivePatchSummaryPayload(
            buildPatchSummaryPayload(db, repoId),
            buildPatchListPayload(db, repoId),
            currentHead,
          ),
          args.includes("--json"),
          formatPatchSummary,
        );
        return;
      case "list":
        printOutput(
          buildLivePatchListPayload(buildPatchListPayload(db, repoId, getArg(args, "--state")), currentHead),
          args.includes("--json"),
          formatPatchList,
        );
        return;
      case "show": {
        const proposalId = args[1];
        if (!proposalId) throw new Error("Usage: monsthera patch show <proposal-id> [--json]");
        const payload = buildPatchDetailPayload(db, repoId, proposalId);
        if (!payload) throw new Error(`Patch not found: ${proposalId}`);
        printOutput(buildLivePatchDetailPayload(payload, currentHead), args.includes("--json"), formatPatchDetail);
        return;
      }
      default:
        throw new Error(`Unknown patch subcommand: ${subcommand}`);
    }
  } catch (error) {
    insight.error(error instanceof Error ? error.message : String(error));
    printPatchHelp();
    process.exitCode = 1;
  } finally {
    sqlite.close();
  }
}

function printOutput<T>(payload: T, asJson: boolean, formatter: (payload: T) => string): void {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(formatter(payload));
}

interface PatchHeadAssessment {
  currentHead: string;
  headMatchesBase: boolean;
  liveStale: boolean;
}

interface LivePatchSummaryPayload extends PatchSummaryPayload {
  currentHead: string;
  liveStaleCount: number;
  headAlignedCount: number;
  recent: Array<PatchListPayload["patches"][number] & PatchHeadAssessment>;
}

interface LivePatchListPayload extends Omit<PatchListPayload, "patches"> {
  currentHead: string;
  patches: Array<PatchListPayload["patches"][number] & PatchHeadAssessment>;
}

type LivePatchDetailPayload = PatchDetailPayload & PatchHeadAssessment;

function formatPatchSummary(payload: LivePatchSummaryPayload): string {
  const lines = [
    `Total patches: ${payload.totalCount}`,
    `Current HEAD: ${payload.currentHead}`,
    `HEAD-aligned patches: ${payload.headAlignedCount}`,
    `Live stale patches: ${payload.liveStaleCount}`,
    "State counts:",
    ...formatCountMap(payload.stateCounts),
    "",
    "Validation:",
    ...formatValidationCountMap(payload.validationCounts),
  ];
  if (payload.recent.length > 0) {
    lines.push("", "Recent:");
    lines.push(...payload.recent.map(formatPatchItem));
  }
  return lines.join("\n");
}

function formatPatchList(payload: LivePatchListPayload): string {
  if (payload.patches.length === 0) return "No matching patches.";
  return [
    `Patches: ${payload.count}`,
    `Current HEAD: ${payload.currentHead}`,
    ...payload.patches.map(formatPatchItem),
  ].join("\n");
}

function formatPatchDetail(payload: LivePatchDetailPayload): string {
  const lines = [
    `${payload.proposalId} [${payload.state}]`,
    payload.message,
    `Base commit: ${payload.baseCommit}`,
    `Current HEAD: ${payload.currentHead}`,
    `Persisted stale: ${payload.persistedStale ? "yes" : "no"}`,
    `Live stale: ${payload.liveStale ? "yes" : "no"}`,
    `Agent: ${payload.agentId}`,
    `Session: ${payload.sessionId}`,
    `Bundle: ${payload.bundleId ?? "-"}`,
    `Committed SHA: ${payload.committedSha ?? "-"}`,
    `Linked ticket: ${payload.linkedTicketId ?? "-"}`,
    `Created: ${payload.createdAt}`,
    `Updated: ${payload.updatedAt}`,
    `Validation: feasible=${formatBooleanFlag(payload.validation.feasible)} | policy=${payload.validation.policyViolationCount} | warnings=${payload.validation.secretWarningCount} | reindex=${payload.validation.reindexScope ?? 0}`,
  ];
  if (payload.touchedPaths.length > 0) {
    lines.push("", "Touched paths:");
    lines.push(...payload.touchedPaths.map((path) => `- ${path}`));
  }
  if (payload.validation.policyViolations.length > 0) {
    lines.push("", "Policy violations:");
    lines.push(...payload.validation.policyViolations.map((entry) => `- ${entry}`));
  }
  if (payload.validation.secretWarnings.length > 0) {
    lines.push("", "Secret warnings:");
    lines.push(...payload.validation.secretWarnings.map((entry) => `- ${entry}`));
  }
  if (payload.dryRunResult) {
    lines.push("", "Dry run result:");
    lines.push(JSON.stringify(payload.dryRunResult, null, 2));
  }
  return lines.join("\n");
}

function formatPatchItem(item: LivePatchListPayload["patches"][number]): string {
  return `${item.proposalId} [${item.state}] head:${item.liveStale ? "stale" : "aligned"} feasible:${formatBooleanFlag(item.validation.feasible)} policy:${item.validation.policyViolationCount} warnings:${item.validation.secretWarningCount} paths:${item.touchedPathCount} | ${item.message} | ${item.agentId} | ${item.linkedTicketId ?? "no-ticket"} | ${item.createdAt}`;
}

function formatCountMap(counts: Record<string, number>): string[] {
  const entries = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) return ["  (none)"];
  return entries.map(([key, value]) => `  ${key}: ${value}`);
}

function formatValidationCountMap(counts: LivePatchSummaryPayload["validationCounts"]): string[] {
  return [
    `  feasible: ${counts.feasible}`,
    `  blocked: ${counts.blocked}`,
    `  unknown: ${counts.unknown}`,
    `  persistedStale: ${counts.persistedStale}`,
    `  withPolicyViolations: ${counts.withPolicyViolations}`,
    `  withSecretWarnings: ${counts.withSecretWarnings}`,
  ];
}

function printPatchHelp(): void {
  console.error("Patch commands:");
  console.error("  monsthera patch summary [--json]");
  console.error("  monsthera patch list [--state <state>] [--json]");
  console.error("  monsthera patch show <proposal-id> [--json]");
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

function buildLivePatchSummaryPayload(
  summary: PatchSummaryPayload,
  list: PatchListPayload,
  currentHead: string,
): LivePatchSummaryPayload {
  const liveStaleCount = list.patches.filter((patch) => patch.baseCommit !== currentHead).length;
  const liveRecent = summary.recent.map((patch) => ({
    ...patch,
    ...buildPatchHeadAssessment(patch.baseCommit, currentHead),
  }));
  return {
    ...summary,
    currentHead,
    liveStaleCount,
    headAlignedCount: list.count - liveStaleCount,
    recent: liveRecent,
  };
}

function buildLivePatchListPayload(
  payload: PatchListPayload,
  currentHead: string,
): LivePatchListPayload {
  return {
    ...payload,
    currentHead,
    patches: payload.patches.map((patch) => ({
      ...patch,
      ...buildPatchHeadAssessment(patch.baseCommit, currentHead),
    })),
  };
}

function buildLivePatchDetailPayload(
  payload: PatchDetailPayload,
  currentHead: string,
): LivePatchDetailPayload {
  return {
    ...payload,
    ...buildPatchHeadAssessment(payload.baseCommit, currentHead),
  };
}

function buildPatchHeadAssessment(baseCommit: string, currentHead: string): PatchHeadAssessment {
  const headMatchesBase = baseCommit === currentHead;
  return {
    currentHead,
    headMatchesBase,
    liveStale: !headMatchesBase,
  };
}

function formatBooleanFlag(value: boolean | null): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  return "unknown";
}
