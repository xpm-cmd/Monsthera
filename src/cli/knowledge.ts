import { basename, join } from "node:path";
import { initDatabase, initGlobalDatabase } from "../db/init.js";
import * as queries from "../db/queries.js";
import { getMainRepoRoot, getRepoRoot, isGitRepo } from "../git/operations.js";
import type { InsightStream } from "../core/insight-stream.js";
import {
  buildKnowledgeDetailPayload,
  buildKnowledgeListPayload,
  buildKnowledgeSummaryPayload,
} from "../knowledge/read-model.js";
import { SearchRouter } from "../search/router.js";
import {
  buildKnowledgeSearchPayload,
  prepareKnowledgeSearchTarget,
  searchKnowledgeEntries,
} from "../knowledge/search.js";
import type { SearchConfig } from "../core/config.js";

const KNOWLEDGE_TYPES = [
  "decision", "gotcha", "pattern", "context", "plan", "solution", "preference",
] as const;

type KnowledgeScope = "repo" | "global" | "all";

export interface KnowledgeCliConfig {
  repoPath: string;
  monstheraDir: string;
  dbName: string;
  zoektEnabled?: boolean;
  semanticEnabled?: boolean;
  search?: SearchConfig;
}

export async function cmdKnowledge(config: KnowledgeCliConfig, insight: InsightStream, args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "help" || args.includes("--help") || args.includes("-h")) {
    printKnowledgeHelp();
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
  const { db, sqlite } = initDatabase({ repoPath: mainRepoRoot, monstheraDir: config.monstheraDir, dbName: config.dbName });
  const { id: repoId } = queries.upsertRepo(db, repoRoot, repoName);
  void repoId;

  let globalDb = null;
  let globalSqlite = null;
  try {
    const globalResult = initGlobalDatabase();
    globalDb = globalResult.globalDb;
    globalSqlite = globalResult.globalSqlite;
  } catch {
    globalDb = null;
    globalSqlite = null;
  }

  try {
    switch (subcommand) {
      case "summary":
        printOutput(buildKnowledgeSummaryPayload(db, globalDb, parseKnowledgeFilters(args)), args.includes("--json"), formatKnowledgeSummary);
        return;
      case "query":
      case "list":
        printOutput(buildKnowledgeListPayload(db, globalDb, parseKnowledgeFilters(args)), args.includes("--json"), formatKnowledgeList);
        return;
      case "search": {
        const query = args[1] ?? getArg(args, "--query");
        if (!query) {
          throw new Error("Usage: monsthera knowledge search <query> [--scope repo|global|all] [--type <type>] [--limit <n>] [--json]");
        }
        const filters = parseKnowledgeFilters(args);
        const searchRouter = new SearchRouter({
          repoId,
          sqlite,
          db,
          repoPath: repoRoot,
          zoektEnabled: config.zoektEnabled ?? true,
          semanticEnabled: config.semanticEnabled ?? false,
          searchConfig: config.search,
          indexDir: join(mainRepoRoot, config.monstheraDir),
          onFallback: (message) => insight.warn(message),
        });
        await searchRouter.initialize();
        if (globalSqlite) {
          prepareKnowledgeSearchTarget(searchRouter, globalSqlite);
        }
        const results = await searchKnowledgeEntries({
          db,
          sqlite,
          globalDb,
          globalSqlite,
          searchRouter,
        }, {
          query,
          scope: filters.scope,
          type: filters.type,
          limit: filters.limit,
        });
        printOutput(buildKnowledgeSearchPayload(query, filters.scope, results), args.includes("--json"), formatKnowledgeSearch);
        return;
      }
      case "show": {
        const key = args[1];
        if (!key) throw new Error("Usage: monsthera knowledge show <key> [--scope repo|global|all] [--json]");
        const payload = buildKnowledgeDetailPayload(db, globalDb, key, parseScope(getArg(args, "--scope")));
        if (!payload) throw new Error(`Knowledge not found: ${key}`);
        printOutput(payload, args.includes("--json"), formatKnowledgeDetail);
        return;
      }
      default:
        throw new Error(`Unknown knowledge subcommand: ${subcommand}`);
    }
  } catch (error) {
    insight.error(error instanceof Error ? error.message : String(error));
    printKnowledgeHelp();
    process.exitCode = 1;
  } finally {
    sqlite.close();
    globalSqlite?.close();
  }
}

function printOutput<T>(payload: T, asJson: boolean, formatter: (payload: T) => string): void {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(formatter(payload));
}

function formatKnowledgeSummary(payload: ReturnType<typeof buildKnowledgeSummaryPayload>): string {
  const lines = [
    `Total entries: ${payload.totalCount}`,
    "Scopes:",
    ...formatCountMap(payload.scopeCounts),
    "",
    "Types:",
    ...formatCountMap(payload.typeCounts),
    "",
    "Statuses:",
    ...formatCountMap(payload.statusCounts),
  ];
  if (payload.recent.length > 0) {
    lines.push("", "Recent:");
    lines.push(...payload.recent.map(formatKnowledgeItem));
  }
  return lines.join("\n");
}

function formatKnowledgeList(payload: ReturnType<typeof buildKnowledgeListPayload>): string {
  if (payload.entries.length === 0) return "No matching knowledge entries.";
  return [
    `Knowledge entries: ${payload.count}`,
    ...payload.entries.map(formatKnowledgeItem),
  ].join("\n");
}

function formatKnowledgeDetail(payload: NonNullable<ReturnType<typeof buildKnowledgeDetailPayload>>): string {
  const lines = [
    `${payload.key} [${payload.scope}]`,
    payload.title,
    `Type: ${payload.type}`,
    `Status: ${payload.status}`,
    `Agent: ${payload.agentId ?? "-"}`,
    `Session: ${payload.sessionId ?? "-"}`,
    `Created: ${payload.createdAt}`,
    `Updated: ${payload.updatedAt}`,
  ];
  if (payload.tags.length > 0) lines.push(`Tags: ${payload.tags.join(", ")}`);
  lines.push("", "Content:", payload.content);
  return lines.join("\n");
}

function formatKnowledgeSearch(payload: ReturnType<typeof buildKnowledgeSearchPayload>): string {
  if (payload.results.length === 0) return `No knowledge results for "${payload.query}".`;
  return [
    `Knowledge search: ${payload.count} result(s) for "${payload.query}" in ${payload.scope}`,
    ...payload.results.map((entry) => (
      `${entry.key} [${entry.scope}] ${entry.title} | ${entry.type} | score ${entry.score}`
    )),
  ].join("\n");
}

function formatKnowledgeItem(item: ReturnType<typeof buildKnowledgeListPayload>["entries"][number]): string {
  return `${item.key} [${item.scope}] ${item.title} | ${item.type} | ${item.status} | ${item.updatedAt}`;
}

function formatCountMap(counts: Record<string, number>): string[] {
  const entries = Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) return ["  (none)"];
  return entries.map(([key, value]) => `  ${key}: ${value}`);
}

function printKnowledgeHelp(): void {
  console.error("Knowledge commands:");
  console.error("  monsthera knowledge summary [--scope repo|global|all] [--status active|archived] [--json]");
  console.error("  monsthera knowledge query [--scope repo|global|all] [--type <type>] [--tags a,b] [--status active|archived] [--limit <n>] [--json]");
  console.error("  monsthera knowledge search <query> [--scope repo|global|all] [--type <type>] [--limit <n>] [--json]");
  console.error("  monsthera knowledge show <key> [--scope repo|global|all] [--json]");
}

function parseKnowledgeFilters(args: string[]) {
  const scope = parseScope(getArg(args, "--scope"));
  const type = getArg(args, "--type");
  if (type && !KNOWLEDGE_TYPES.includes(type as (typeof KNOWLEDGE_TYPES)[number])) {
    throw new Error(`Invalid knowledge type: ${type}`);
  }

  const status = getArg(args, "--status");
  if (status && status !== "active" && status !== "archived") {
    throw new Error(`Invalid knowledge status: ${status}`);
  }

  const limitRaw = getArg(args, "--limit");
  const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : null;
  if (limitRaw && (parsedLimit === null || !Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100)) {
    throw new Error(`Invalid knowledge limit: ${limitRaw}`);
  }

  return {
    scope,
    type,
    tags: parseTagsArg(getArg(args, "--tags")),
    status,
    limit: parsedLimit ?? undefined,
  };
}

function parseScope(raw: string | undefined): KnowledgeScope {
  if (!raw) return "all";
  if (raw === "repo" || raw === "global" || raw === "all") return raw;
  throw new Error(`Invalid knowledge scope: ${raw}`);
}

function parseTagsArg(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const tags = raw.split(",").map((tag) => tag.trim()).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}
