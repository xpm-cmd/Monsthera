import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgoraServer } from "./server.js";
import { resolveConfig } from "./core/config.js";
import { VERSION } from "./core/constants.js";
import { initDatabase } from "./db/init.js";
import { InsightStream } from "./core/insight-stream.js";
import { fullIndex, getIndexedCommit } from "./indexing/indexer.js";
import { isGitRepo, getRepoRoot } from "./git/operations.js";
import * as queries from "./db/queries.js";
import { basename, join } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const repoPath = getArg(args, "--repo-path") ?? process.cwd();
  const verbosity = (getArg(args, "--verbosity") ?? "normal") as "quiet" | "normal" | "verbose";
  const debugLogging = args.includes("--debug-logging");

  if (args.includes("--version") || args.includes("-v")) {
    console.error(`agora v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h") || command === "help") {
    printHelp();
    process.exit(0);
  }

  const config = resolveConfig({ repoPath, verbosity, debugLogging });
  const insight = new InsightStream(config.verbosity);

  switch (command) {
    case "init":
      await cmdInit(config, insight);
      break;
    case "index":
      await cmdIndex(config, insight);
      break;
    case "status":
      await cmdStatus(config, insight);
      break;
    case "serve":
    case undefined:
      await cmdServe(config, insight);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

async function cmdServe(config: ReturnType<typeof resolveConfig>, insight: InsightStream) {
  insight.info(`v${VERSION} starting for ${config.repoPath}`);
  if (config.debugLogging) {
    insight.warn("Debug logging active — raw payloads captured (24h TTL)");
  }

  const server = createAgoraServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function cmdInit(config: ReturnType<typeof resolveConfig>, insight: InsightStream) {
  if (!(await isGitRepo({ cwd: config.repoPath }))) {
    insight.error("Not a git repository");
    process.exit(1);
  }

  const repoRoot = await getRepoRoot({ cwd: config.repoPath });
  const agoraDir = join(repoRoot, config.agoraDir);

  mkdirSync(agoraDir, { recursive: true });

  const configPath = join(agoraDir, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({
      zoektEnabled: true,
      coordinationTopology: "hub-spoke",
      sensitiveFilePatterns: [".env", ".env.*", "*.key", "*.pem", "credentials.*", "secrets.*"],
    }, null, 2) + "\n");
    insight.info(`Created ${configPath}`);
  }

  // Initialize database
  initDatabase({ repoPath: repoRoot, agoraDir: config.agoraDir, dbName: config.dbName });
  insight.info(`Initialized Agora in ${agoraDir}`);

  // Add .agora to .gitignore if not already there
  const gitignorePath = join(repoRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = await import("node:fs").then((fs) => fs.readFileSync(gitignorePath, "utf-8"));
    if (!content.includes(".agora")) {
      writeFileSync(gitignorePath, content.trimEnd() + "\n.agora/\n");
      insight.info("Added .agora/ to .gitignore");
    }
  }
}

async function cmdIndex(config: ReturnType<typeof resolveConfig>, insight: InsightStream) {
  if (!(await isGitRepo({ cwd: config.repoPath }))) {
    insight.error("Not a git repository");
    process.exit(1);
  }

  const repoRoot = await getRepoRoot({ cwd: config.repoPath });
  const repoName = basename(repoRoot);
  const { db } = initDatabase({ repoPath: repoRoot, agoraDir: config.agoraDir, dbName: config.dbName });
  const { id: repoId } = queries.upsertRepo(db, repoRoot, repoName);

  insight.info("Starting full index...");
  const result = await fullIndex({
    repoPath: repoRoot,
    repoId,
    db,
    sensitiveFilePatterns: config.sensitiveFilePatterns,
    onProgress: (msg) => insight.detail(msg),
  });

  insight.info(`Done: ${result.filesIndexed} files indexed at ${result.commit.slice(0, 7)} (${result.durationMs}ms)`);
  if (result.errors.length > 0) {
    insight.warn(`${result.errors.length} errors during indexing`);
  }
}

async function cmdStatus(config: ReturnType<typeof resolveConfig>, insight: InsightStream) {
  if (!(await isGitRepo({ cwd: config.repoPath }))) {
    insight.error("Not a git repository");
    process.exit(1);
  }

  const repoRoot = await getRepoRoot({ cwd: config.repoPath });
  const repoName = basename(repoRoot);
  const { db } = initDatabase({ repoPath: repoRoot, agoraDir: config.agoraDir, dbName: config.dbName });
  const { id: repoId } = queries.upsertRepo(db, repoRoot, repoName);

  const indexedCommit = getIndexedCommit(db, repoId);
  const fileCount = queries.getFileCount(db, repoId);
  const agents = queries.getAllAgents(db);
  const activeSessions = queries.getActiveSessions(db);

  console.error(`Agora v${VERSION}`);
  console.error(`  Repo: ${repoRoot}`);
  console.error(`  Indexed commit: ${indexedCommit ?? "(not indexed)"}`);
  console.error(`  Files: ${fileCount}`);
  console.error(`  Agents: ${agents.length}`);
  console.error(`  Active sessions: ${activeSessions.length}`);
}

function printHelp() {
  console.error(`agora v${VERSION} — Multi-agent shared context server`);
  console.error("");
  console.error("Commands:");
  console.error("  serve          Start MCP server (default)");
  console.error("  init           Initialize .agora directory");
  console.error("  index          Run full index");
  console.error("  status         Show index status");
  console.error("");
  console.error("Options:");
  console.error("  --repo-path    Repository path (default: cwd)");
  console.error("  --verbosity    quiet | normal | verbose");
  console.error("  --debug-logging  Enable raw payload capture");
  console.error("  --version, -v  Show version");
  console.error("  --help, -h     Show help");
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

main().catch((err) => {
  console.error("[AGORA] Fatal error:", err);
  process.exit(1);
});
