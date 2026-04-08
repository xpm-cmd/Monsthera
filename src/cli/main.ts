/* eslint-disable no-console */
import { loadConfig, defaultConfig } from "../core/config.js";
import { createContainer } from "../core/container.js";
import { VERSION } from "../core/constants.js";
import { startServer } from "../server.js";
import {
  formatSearchResults,
  formatError,
} from "./formatters.js";
import { parseFlag, withContainer } from "./arg-helpers.js";
import { handleKnowledge } from "./knowledge-commands.js";
import { handleWork } from "./work-commands.js";

// ─── Top-level commands ─────────────────────────────────��───────────────────

async function handleServe(args: string[]): Promise<void> {
  const repoPath = parseFlag(args, "--repo", "-r") ?? process.cwd();
  const configResult = loadConfig(repoPath);
  const config = configResult.ok ? configResult.value : defaultConfig(repoPath);
  const container = await createContainer(config);
  await startServer(container);
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
      "  status                   Print system status as JSON and exit",
      "  knowledge <subcommand>   Manage knowledge articles",
      "  work <subcommand>        Manage work articles",
      "  search <query>           Search across all articles",
      "  reindex                  Rebuild the search index",
      "  doctor                   Run health checks and diagnostics",
      "",
      "KNOWLEDGE SUBCOMMANDS",
      "  knowledge create  --title <t> --category <c> --content <body> [--tags t1,t2] [--code-refs r1,r2]",
      "  knowledge get     <id-or-slug>",
      "  knowledge list    [--category <c>]",
      "  knowledge update  <id> [--title <t>] [--category <c>] [--content <body>] [--tags t1,t2]",
      "  knowledge delete  <id>",
      "",
      "WORK SUBCOMMANDS",
      "  work create   --title <t> --template <template> --author <a> [--priority <p>] [--tags t1,t2]",
      "  work get      <id>",
      "  work list     [--phase <p>]",
      "  work update   <id> [--title <t>] [--assignee <a>] [--priority <p>]",
      "  work advance  <id> --phase <target>",
      "  work enrich   <id> --role <role> --status <contributed|skipped>",
      "  work review   <id> --reviewer <agent-id> --status <approved|changes-requested>",
      "",
      "OPTIONS",
      "  --repo, -r <path>   Repository path (defaults to cwd)",
      "  --version, -v       Print version and exit",
      "  --help, -h          Show this help message",
      "",
      "EXAMPLES",
      "  monsthera serve",
      "  monsthera knowledge create --title \"API Design\" --category architecture --content \"REST vs GraphQL...\"",
      "  monsthera work create --title \"Add auth\" --template feature --author agent-1 --priority high",
      "  monsthera search \"authentication\"",
      "  monsthera reindex",
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
    process.stdout.write(
      `Reindex complete: ${knowledgeCount} knowledge article(s), ${workCount} work article(s).\n`,
    );
  });
}

// ─── Doctor ─────────────────────────────────────────────────────────────────

async function handleDoctor(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    process.stdout.write("Monsthera Doctor\n");
    process.stdout.write("================\n\n");

    const status = container.status.getStatus();

    // Version & uptime
    process.stdout.write(`Version: ${status.version}\n`);
    process.stdout.write(`Uptime: ${Math.round(status.uptime / 1000)}s\n\n`);

    // Subsystem health
    process.stdout.write("Subsystems:\n");
    let allHealthy = true;
    for (const sub of status.subsystems) {
      const icon = sub.healthy ? "[OK]" : "[FAIL]";
      if (!sub.healthy) allHealthy = false;
      process.stdout.write(`  ${icon} ${sub.name}${sub.detail ? ` — ${sub.detail}` : ""}\n`);
    }
    process.stdout.write("\n");

    // Article counts
    const knowledgeResult = await container.knowledgeService.listArticles();
    const workResult = await container.workService.listWork();
    if (knowledgeResult.ok) {
      process.stdout.write(`Knowledge articles: ${knowledgeResult.value.length}\n`);
    }
    if (workResult.ok) {
      process.stdout.write(`Work articles: ${workResult.value.length}\n`);
    }
    process.stdout.write("\n");

    // Overall verdict
    if (allHealthy) {
      process.stdout.write("All systems healthy.\n");
    } else {
      process.stdout.write("Some subsystems are unhealthy. Check configuration.\n");
      process.exit(1);
    }
  });
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function main(args: string[]): Promise<void> {
  const command = args[0];

  try {
    switch (command) {
      case "serve":
        await handleServe(args.slice(1));
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
      case "search":
        await handleSearch(args.slice(1));
        break;
      case "reindex":
        await handleReindex(args.slice(1));
        break;
      case "doctor":
        await handleDoctor(args.slice(1));
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
