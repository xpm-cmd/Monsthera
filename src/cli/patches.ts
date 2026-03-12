import { basename } from "node:path";
import { initDatabase } from "../db/init.js";
import * as queries from "../db/queries.js";
import { getMainRepoRoot, getRepoRoot, isGitRepo } from "../git/operations.js";
import type { InsightStream } from "../core/insight-stream.js";
import { buildPatchDetailPayload, buildPatchListPayload, buildPatchSummaryPayload } from "../patches/read-model.js";

export interface PatchCliConfig {
  repoPath: string;
  agoraDir: string;
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
  const repoName = basename(repoRoot);
  const { db, sqlite } = initDatabase({ repoPath: mainRepoRoot, agoraDir: config.agoraDir, dbName: config.dbName });
  const { id: repoId } = queries.upsertRepo(db, repoRoot, repoName);

  try {
    switch (subcommand) {
      case "summary":
        printOutput(buildPatchSummaryPayload(db, repoId), args.includes("--json"), formatPatchSummary);
        return;
      case "list":
        printOutput(buildPatchListPayload(db, repoId, getArg(args, "--state")), args.includes("--json"), formatPatchList);
        return;
      case "show": {
        const proposalId = args[1];
        if (!proposalId) throw new Error("Usage: agora patch show <proposal-id> [--json]");
        const payload = buildPatchDetailPayload(db, repoId, proposalId);
        if (!payload) throw new Error(`Patch not found: ${proposalId}`);
        printOutput(payload, args.includes("--json"), formatPatchDetail);
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

function formatPatchSummary(payload: ReturnType<typeof buildPatchSummaryPayload>): string {
  const lines = [
    `Total patches: ${payload.totalCount}`,
    "State counts:",
    ...formatCountMap(payload.stateCounts),
  ];
  if (payload.recent.length > 0) {
    lines.push("", "Recent:");
    lines.push(...payload.recent.map(formatPatchItem));
  }
  return lines.join("\n");
}

function formatPatchList(payload: ReturnType<typeof buildPatchListPayload>): string {
  if (payload.patches.length === 0) return "No matching patches.";
  return [
    `Patches: ${payload.count}`,
    ...payload.patches.map(formatPatchItem),
  ].join("\n");
}

function formatPatchDetail(payload: NonNullable<ReturnType<typeof buildPatchDetailPayload>>): string {
  const lines = [
    `${payload.proposalId} [${payload.state}]`,
    payload.message,
    `Base commit: ${payload.baseCommit}`,
    `Agent: ${payload.agentId}`,
    `Session: ${payload.sessionId}`,
    `Bundle: ${payload.bundleId ?? "-"}`,
    `Committed SHA: ${payload.committedSha ?? "-"}`,
    `Linked ticket: ${payload.linkedTicketId ?? "-"}`,
    `Created: ${payload.createdAt}`,
    `Updated: ${payload.updatedAt}`,
  ];
  if (payload.touchedPaths.length > 0) {
    lines.push("", "Touched paths:");
    lines.push(...payload.touchedPaths.map((path) => `- ${path}`));
  }
  if (payload.dryRunResult) {
    lines.push("", "Dry run result:");
    lines.push(JSON.stringify(payload.dryRunResult, null, 2));
  }
  return lines.join("\n");
}

function formatPatchItem(item: ReturnType<typeof buildPatchListPayload>["patches"][number]): string {
  return `${item.proposalId} [${item.state}] ${item.message} | ${item.agentId} | ${item.linkedTicketId ?? "no-ticket"} | ${item.createdAt}`;
}

function formatCountMap(counts: Record<string, number>): string[] {
  const entries = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) return ["  (none)"];
  return entries.map(([key, value]) => `  ${key}: ${value}`);
}

function printPatchHelp(): void {
  console.error("Patch commands:");
  console.error("  agora patch summary [--json]");
  console.error("  agora patch list [--state <state>] [--json]");
  console.error("  agora patch show <proposal-id> [--json]");
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}
