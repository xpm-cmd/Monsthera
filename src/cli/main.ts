/* eslint-disable no-console */
import { loadConfig, defaultConfig } from "../core/config.js";
import { createContainer } from "../core/container.js";
import type { MonstheraContainer } from "../core/container.js";
import { VERSION } from "../core/constants.js";
import type { WorkPhase } from "../core/types.js";
import { startServer } from "../server.js";
import {
  formatArticle,
  formatWorkArticle,
  formatSearchResults,
  formatTable,
  formatError,
} from "./formatters.js";

// ─── Arg-parsing helpers ─────────────────────────────────────────────────────

function parseFlag(args: string[], flag: string, short?: string): string | undefined {
  const idx = args.findIndex((a) => a === flag || (short && a === short));
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return undefined;
}

function requireFlag(args: string[], flag: string, short?: string): string {
  const value = parseFlag(args, flag, short);
  if (!value) {
    throw new Error(`Missing required flag: ${flag}`);
  }
  return value;
}

function parsePositional(args: string[], index: number): string | undefined {
  // Skip flag pairs (--key value) and return positional args
  let pos = 0;
  for (let i = 0; i < args.length; i++) {
    const arg: string | undefined = args[i];
    if (arg === undefined || arg.startsWith("-")) {
      if (arg !== undefined) i++; // skip value of the flag
      continue;
    }
    if (pos === index) return arg;
    pos++;
  }
  return undefined;
}

function parseRepoPath(args: string[]): string | undefined {
  return parseFlag(args, "--repo", "-r");
}

function parseCommaSeparated(args: string[], flag: string, short?: string): string[] | undefined {
  const value = parseFlag(args, flag, short);
  if (!value) return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

// ─── Container helper ────────────────────────────────────────────────────────

async function withContainer<T>(args: string[], fn: (container: MonstheraContainer) => Promise<T>): Promise<T> {
  const repoPath = parseRepoPath(args) ?? process.cwd();
  const configResult = loadConfig(repoPath);
  const config = configResult.ok ? configResult.value : defaultConfig(repoPath);
  const container = await createContainer(config);
  try {
    return await fn(container);
  } finally {
    await container.dispose();
  }
}

// ─── Command handlers ────────────────────────────────────────────────────────

async function handleServe(args: string[]): Promise<void> {
  const repoPath = parseRepoPath(args) ?? process.cwd();
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

// ─── Knowledge commands ──────────────────────────────────────────────────────

async function handleKnowledge(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "create":
      await handleKnowledgeCreate(subArgs);
      break;
    case "get":
      await handleKnowledgeGet(subArgs);
      break;
    case "list":
      await handleKnowledgeList(subArgs);
      break;
    case "update":
      await handleKnowledgeUpdate(subArgs);
      break;
    case "delete":
      await handleKnowledgeDelete(subArgs);
      break;
    default:
      console.error(`Unknown knowledge subcommand: ${subcommand ?? "(none)"}`);
      console.error('Run "monsthera --help" for usage.');
      process.exit(1);
  }
}

async function handleKnowledgeCreate(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const title = requireFlag(args, "--title");
    const category = requireFlag(args, "--category");
    const content = requireFlag(args, "--content");
    const tags = parseCommaSeparated(args, "--tags");
    const codeRefs = parseCommaSeparated(args, "--code-refs");

    const input: Record<string, unknown> = { title, category, content };
    if (tags) input.tags = tags;
    if (codeRefs) input.codeRefs = codeRefs;

    const result = await container.knowledgeService.createArticle(input);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatArticle(result.value) + "\n");
  });
}

async function handleKnowledgeGet(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const idOrSlug = parsePositional(args, 0);
    if (!idOrSlug) {
      console.error("Missing required argument: <id-or-slug>");
      process.exit(1);
    }

    // Try by ID first, then by slug
    const result = await container.knowledgeService.getArticle(idOrSlug);
    if (result.ok) {
      process.stdout.write(formatArticle(result.value) + "\n");
      return;
    }

    const slugResult = await container.knowledgeService.getArticleBySlug(idOrSlug);
    if (!slugResult.ok) {
      console.error(formatError(slugResult.error));
      process.exit(1);
    }
    process.stdout.write(formatArticle(slugResult.value) + "\n");
  });
}

async function handleKnowledgeList(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const category = parseFlag(args, "--category");
    const result = await container.knowledgeService.listArticles(category);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }

    if (result.value.length === 0) {
      process.stdout.write("No knowledge articles found.\n");
      return;
    }

    const headers = ["ID", "TITLE", "CATEGORY", "TAGS", "UPDATED"];
    const rows = result.value.map((a) => [
      a.id,
      a.title,
      a.category,
      a.tags.join(", "),
      a.updatedAt,
    ]);
    process.stdout.write(formatTable(headers, rows) + "\n");
  });
}

async function handleKnowledgeUpdate(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const input: Record<string, unknown> = {};
    const title = parseFlag(args, "--title");
    const category = parseFlag(args, "--category");
    const content = parseFlag(args, "--content");
    const tags = parseCommaSeparated(args, "--tags");

    if (title) input.title = title;
    if (category) input.category = category;
    if (content) input.content = content;
    if (tags) input.tags = tags;

    if (Object.keys(input).length === 0) {
      console.error("No update fields provided. Use --title, --category, --content, or --tags.");
      process.exit(1);
    }

    const result = await container.knowledgeService.updateArticle(id, input);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatArticle(result.value) + "\n");
  });
}

async function handleKnowledgeDelete(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const result = await container.knowledgeService.deleteArticle(id);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(`Deleted knowledge article: ${id}\n`);
  });
}

// ─── Work commands ───────────────────────────────────────────────────────────

async function handleWork(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case "create":
      await handleWorkCreate(subArgs);
      break;
    case "get":
      await handleWorkGet(subArgs);
      break;
    case "list":
      await handleWorkList(subArgs);
      break;
    case "update":
      await handleWorkUpdate(subArgs);
      break;
    case "advance":
      await handleWorkAdvance(subArgs);
      break;
    case "enrich":
      await handleWorkEnrich(subArgs);
      break;
    case "review":
      await handleWorkReview(subArgs);
      break;
    default:
      console.error(`Unknown work subcommand: ${subcommand ?? "(none)"}`);
      console.error('Run "monsthera --help" for usage.');
      process.exit(1);
  }
}

async function handleWorkCreate(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const title = requireFlag(args, "--title");
    const template = requireFlag(args, "--template");
    const author = requireFlag(args, "--author");
    const priority = parseFlag(args, "--priority") ?? "medium";
    const tags = parseCommaSeparated(args, "--tags");
    const content = parseFlag(args, "--content");

    const input: Record<string, unknown> = { title, template, author, priority };
    if (tags) input.tags = tags;
    if (content) input.content = content;

    const result = await container.workService.createWork(input);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatWorkArticle(result.value) + "\n");
  });
}

async function handleWorkGet(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const result = await container.workService.getWork(id);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatWorkArticle(result.value) + "\n");
  });
}

async function handleWorkList(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const phase = parseFlag(args, "--phase") as WorkPhase | undefined;
    const result = await container.workService.listWork(phase);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }

    if (result.value.length === 0) {
      process.stdout.write("No work articles found.\n");
      return;
    }

    const headers = ["ID", "TITLE", "TEMPLATE", "PHASE", "PRIORITY", "UPDATED"];
    const rows = result.value.map((w) => [
      w.id,
      w.title,
      w.template,
      w.phase,
      w.priority,
      w.updatedAt,
    ]);
    process.stdout.write(formatTable(headers, rows) + "\n");
  });
}

async function handleWorkUpdate(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const input: Record<string, unknown> = {};
    const title = parseFlag(args, "--title");
    const assignee = parseFlag(args, "--assignee");
    const priority = parseFlag(args, "--priority");
    const tags = parseCommaSeparated(args, "--tags");
    const content = parseFlag(args, "--content");

    if (title) input.title = title;
    if (assignee) input.assignee = assignee;
    if (priority) input.priority = priority;
    if (tags) input.tags = tags;
    if (content) input.content = content;

    if (Object.keys(input).length === 0) {
      console.error("No update fields provided. Use --title, --assignee, --priority, --tags, or --content.");
      process.exit(1);
    }

    const result = await container.workService.updateWork(id, input);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatWorkArticle(result.value) + "\n");
  });
}

async function handleWorkAdvance(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const phase = requireFlag(args, "--phase") as WorkPhase;
    const result = await container.workService.advancePhase(id, phase);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatWorkArticle(result.value) + "\n");
  });
}

async function handleWorkEnrich(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const role = requireFlag(args, "--role");
    const status = requireFlag(args, "--status") as "contributed" | "skipped";
    const result = await container.workService.contributeEnrichment(id, role, status);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatWorkArticle(result.value) + "\n");
  });
}

async function handleWorkReview(args: string[]): Promise<void> {
  await withContainer(args, async (container) => {
    const id = parsePositional(args, 0);
    if (!id) {
      console.error("Missing required argument: <id>");
      process.exit(1);
    }

    const reviewer = requireFlag(args, "--reviewer");
    const status = requireFlag(args, "--status") as "approved" | "changes-requested";
    const result = await container.workService.submitReview(id, reviewer, status);
    if (!result.ok) {
      console.error(formatError(result.error));
      process.exit(1);
    }
    process.stdout.write(formatWorkArticle(result.value) + "\n");
  });
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
