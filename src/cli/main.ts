/* eslint-disable no-console */
import * as path from "node:path";
import { loadConfig, defaultConfig } from "../core/config.js";
import { createContainer } from "../core/container.js";
import { VERSION } from "../core/constants.js";
import { startServer } from "../server.js";
import { startDashboard } from "../dashboard/index.js";
import { SqliteV2SourceReader } from "../migration/v2-reader.js";
import { WikiBookkeeper } from "../knowledge/wiki-bookkeeper.js";
import type { MigrationMode, MigrationScope } from "../migration/types.js";
import {
  formatSearchResults,
  formatError,
} from "./formatters.js";
import { parseFlag, withContainer } from "./arg-helpers.js";
import { handleKnowledge } from "./knowledge-commands.js";
import { handleWork } from "./work-commands.js";
import { handleIngest } from "./ingest-commands.js";
import { handleDoctor } from "./doctor-commands.js";
import { handlePack } from "./context-commands.js";

// ─── Top-level commands ─────────────────────────────────��───────────────────

async function handleServe(args: string[]): Promise<void> {
  const repoPath = parseFlag(args, "--repo", "-r") ?? process.cwd();
  const configResult = loadConfig(repoPath);
  const config = configResult.ok ? configResult.value : defaultConfig(repoPath);
  const sourcePath = parseFlag(args, "--source");
  const v2Reader = sourcePath ? new SqliteV2SourceReader(sourcePath) : undefined;
  const container = await createContainer(config, v2Reader ? { v2Reader } : undefined);
  await startServer(container);
}

async function handleDashboard(args: string[]): Promise<void> {
  const repoPath = parseFlag(args, "--repo", "-r") ?? process.cwd();
  const configResult = loadConfig(repoPath);
  const config = configResult.ok ? configResult.value : defaultConfig(repoPath);
  const container = await createContainer(config);
  const portFlag = parseFlag(args, "--port", "-p");
  const port = portFlag ? Number(portFlag) : undefined;
  const dashboard = await startDashboard(container, port);
  process.stdout.write(`Dashboard running at http://localhost:${dashboard.port}\n`);
  process.stdout.write(`Auth token: ${dashboard.authToken}\n`);
}

async function handleStatus(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const status = container.status.getStatus();
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
  });
}

function handleVersion(): void {
  process.stdout.write(VERSION + "\n");
}

function handleHelp(): void {
  process.stdout.write(
    [
      "monsthera — Knowledge-native development platform for AI coding agents",
      "",
      "USAGE",
      "  monsthera <command> [options]",
      "",
      "COMMANDS",
      "  serve                    Start the MCP server (stdio transport)",
      "  dashboard                Start the HTTP dashboard server",
      "  status                   Print system status as JSON and exit",
      "  knowledge <subcommand>   Manage knowledge articles",
      "  work <subcommand>        Manage work articles",
      "  ingest <subcommand>      Import local sources into knowledge",
      "  search <query>           Search across all articles",
      "  pack <query>             Build a ranked context pack (optionally record snapshot)",
      "  reindex                  Rebuild the search index",
      "  migrate                  Run v2 -> v3 migration from SQLite",
      "  doctor                   Run health checks and diagnostics",
      "",
      "KNOWLEDGE SUBCOMMANDS",
      "  knowledge create  --title <t> --category <c> --content <body> [--tags t1,t2] [--code-refs r1,r2]",
      "  knowledge get     <id-or-slug>",
      "  knowledge list    [--category <c>] [--json]",
      "  knowledge update  <id> [--title <t>] [--category <c>] [--content <body>] [--tags t1,t2]",
      "  knowledge delete  <id>",
      "",
      "WORK SUBCOMMANDS",
      "  work create   --title <t> --template <template> --author <a> [--priority <p>] [--tags t1,t2]",
      "                [--content <body> | --content-file <path> | --edit]",
      "  work get      <id>",
      "  work list     [--phase <p>] [--json]",
      "  work update   <id> [--title <t>] [--assignee <a>] [--priority <p>] [--tags t1,t2]",
      "                [--content <body> | --content-file <path> | --edit]",
      "  work delete   <id>",
      "  work advance  <id> --phase <target> [--reason <text>] [--skip-guard-reason <text>]",
      "  work close    <id> (--pr <n> | --reason <text>)",
      "  work enrich   <id> --role <role> --status <contributed|skipped>",
      "  work review   <id> --reviewer <agent-id> --status <approved|changes-requested>",
      "",
      "INGEST SUBCOMMANDS",
      "  ingest local  --path <file-or-dir> [--category <c>] [--tags t1,t2] [--code-refs r1,r2] [--summary] [--no-recursive] [--no-replace]",
      "",
      "MIGRATION",
      "  migrate [--mode <dry-run|validate|execute>] [--scope <work|knowledge|all>] [--source <sqlite-path>] [--force] [--json]",
      "",
      "OPTIONS",
      "  --repo, -r <path>   Repository path (defaults to cwd)",
      "  --version, -v       Print version and exit",
      "  --help, -h          Show this help message",
      "",
      "PACK",
      "  monsthera pack <query...> [--mode general|code|research] [--limit N] [--type knowledge|work|all]",
      "                            [--agent-id A] [--work-id W] [--include-content] [--verbose] [--json]",
      "                            [--record <path>|- ]",
      "",
      "EXAMPLES",
      "  monsthera serve",
      "  monsthera knowledge create --title \"API Design\" --category architecture --content \"REST vs GraphQL...\"",
      "  monsthera work create --title \"Add auth\" --template feature --author agent-1 --priority high",
      "  monsthera ingest local --path docs/adrs --summary",
      "  monsthera search \"authentication\"",
      "  pnpm exec tsx scripts/capture-env-snapshot.ts --agent-id a-1 --work-id w-xxx | monsthera pack \"token use\" --record - --work-id w-xxx",
      "  monsthera reindex",
      "  monsthera migrate --mode dry-run --scope all --source .monsthera/monsthera.db --json",
      "",
    ].join("\n"),
  );
}

// ─── Search & Reindex ────────────────────────────────────────────────────────

async function handleSearch(args: string[]): Promise<void> {
  // Collect all non-flag args as the query
  const queryParts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg: string | undefined = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith("-")) {
      i++; // skip flag value
      continue;
    }
    queryParts.push(arg);
  }

  const query = queryParts.join(" ");
  if (!query) {
    console.error("Missing required argument: <query>");
    process.exit(1);
  }

  await withContainer(args, async (container) => {
    const type = parseFlag(args, "--type") as "knowledge" | "work" | "all" | undefined;
    const limit = parseFlag(args, "--limit");

    const input: Record<string, unknown> = { query };
    if (type) input.type = type;
    if (limit) input.limit = parseInt(limit, 10);

    const result = await container.searchService.search(input);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatSearchResults(result.value) + "\n");
  });
}

async function handleReindex(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    process.stdout.write("Rebuilding search index...\n");
    const result = await container.searchService.fullReindex();
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    const { knowledgeCount, workCount } = result.value;

    // Rebuild wiki index.md alongside the search index
    const markdownRoot = path.resolve(container.config.repoPath, container.config.storage.markdownRoot);
    const bookkeeper = new WikiBookkeeper(markdownRoot, container.logger);
    const knowledgeAll = await container.knowledgeRepo.findMany();
    const workAll = await container.workRepo.findMany();
    if (knowledgeAll.ok && workAll.ok) {
      await bookkeeper.rebuildIndex(knowledgeAll.value, workAll.value);
      await bookkeeper.appendLog("reindex", "knowledge", `Reindex: ${knowledgeCount} knowledge, ${workCount} work`);
    }

    process.stdout.write(
      `Reindex complete: ${knowledgeCount} knowledge article(s), ${workCount} work article(s).\n`,
    );
  });
}

// ─── Migration ──────────────────────────────────────────────────────────────

function parseMigrationMode(args: string[]): MigrationMode {
  if (args.includes("--dry-run")) return "dry-run";
  if (args.includes("--validate")) return "validate";
  if (args.includes("--execute")) return "execute";
  return (parseFlag(args, "--mode") as MigrationMode | undefined) ?? "dry-run";
}

async function handleMigrate(args: string[]): Promise<void> {
  const repoPath = parseFlag(args, "--repo", "-r") ?? process.cwd();
  const configResult = loadConfig(repoPath);
  const config = configResult.ok ? configResult.value : defaultConfig(repoPath);
  const sourcePath = parseFlag(args, "--source") ?? path.join(repoPath, ".monsthera", "monsthera.db");
  const mode = parseMigrationMode(args);
  const scope = (parseFlag(args, "--scope") as MigrationScope | undefined) ?? "all";
  const force = args.includes("--force");
  const asJson = args.includes("--json");

  const container = await createContainer(config, { v2Reader: new SqliteV2SourceReader(sourcePath) });

  try {
    if (!container.migrationService) {
      console.error("Migration service is unavailable.");
      process.exit(1);
    }

    const result = await container.migrationService.run(mode, { force, scope });
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }

    if (asJson) {
      process.stdout.write(JSON.stringify(result.value, null, 2) + "\n");
      return;
    }

    process.stdout.write(
      [
        `Mode: ${result.value.mode}`,
        `Scope: ${result.value.scope}`,
        `Total: ${result.value.total}`,
        `Created: ${result.value.created}`,
        `Skipped: ${result.value.skipped}`,
        `Failed: ${result.value.failed}`,
        "",
      ].join("\n"),
    );

    for (const item of result.value.items) {
      const suffix = item.reason ? ` (${item.reason})` : "";
      process.stdout.write(`- [${item.scope}] ${item.sourceId}: ${item.status}${suffix}\n`);
    }
  } finally {
    await container.dispose();
  }
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function main(args: string[]): Promise<void> {
  const command = args[0];

  try {
    switch (command) {
      case "serve":
        await handleServe(args.slice(1));
        break;
      case "dashboard":
        await handleDashboard(args.slice(1));
        break;
      case "status":
        await handleStatus(args.slice(1));
        break;
      case "knowledge":
        await handleKnowledge(args.slice(1));
        break;
      case "work":
        await handleWork(args.slice(1));
        break;
      case "ingest":
        await handleIngest(args.slice(1));
        break;
      case "search":
        await handleSearch(args.slice(1));
        break;
      case "reindex":
        await handleReindex(args.slice(1));
        break;
      case "migrate":
        await handleMigrate(args.slice(1));
        break;
      case "doctor":
        await handleDoctor(args.slice(1));
        break;
      case "pack":
        await handlePack(args.slice(1));
        break;
      case "--version":
      case "-v":
        handleVersion();
        break;
      case "--help":
      case "-h":
      case undefined:
        handleHelp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error('Run "monsthera --help" for usage.');
        process.exit(1);
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.error(`Error: ${error.message}`);
    } else {
      console.error("An unexpected error occurred");
    }
    process.exit(1);
  }
}
