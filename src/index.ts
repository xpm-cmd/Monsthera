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
  const transport = (getArg(args, "--transport") ?? "stdio") as "stdio" | "http";
  const httpPort = parseInt(getArg(args, "--http-port") ?? "3000", 10);
  const noDashboard = args.includes("--no-dashboard");

  if (args.includes("--version") || args.includes("-v")) {
    console.error(`agora v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h") || command === "help") {
    printHelp();
    process.exit(0);
  }

  const config = resolveConfig({ repoPath, verbosity, debugLogging, transport, httpPort, noDashboard });
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

  // Start dashboard if repo is valid and not disabled
  try {
    if (!config.noDashboard && await isGitRepo({ cwd: config.repoPath })) {
      const repoRoot = await getRepoRoot({ cwd: config.repoPath });
      const repoName = basename(repoRoot);
      const { db } = initDatabase({ repoPath: repoRoot, agoraDir: config.agoraDir, dbName: config.dbName });
      const { id: repoId } = queries.upsertRepo(db, repoRoot, repoName);
      const { CoordinationBus } = await import("./coordination/bus.js");
      const { startDashboard } = await import("./dashboard/server.js");
      const bus = new CoordinationBus(config.coordinationTopology ?? "hub-spoke");
      startDashboard({ db, repoId, repoPath: repoRoot, bus }, config.dashboardPort, insight);
    }
  } catch (err) {
    insight.warn(`Dashboard failed to start: ${err}`);
  }

  if (config.transport === "http") {
    await cmdServeHttp(config, insight);
  } else {
    const server = createAgoraServer(config);
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
  }
}

async function cmdServeHttp(config: ReturnType<typeof resolveConfig>, insight: InsightStream) {
  const { createServer } = await import("node:http");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const { randomUUID } = await import("node:crypto");

  // Map of sessionId → { server, transport }
  const sessions = new Map<string, { server: ReturnType<typeof createAgoraServer>; transport: InstanceType<typeof StreamableHTTPServerTransport> }>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${config.httpPort}`);

    // Only handle /mcp endpoint
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. Use /mcp endpoint." }));
      return;
    }

    // Extract session ID from header
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      // Existing session — route to its transport
      const session = sessions.get(sessionId)!;
      await session.transport.handleRequest(req, res);
      return;
    }

    if (sessionId && !sessions.has(sessionId)) {
      // Unknown session ID → 404
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found. Send an initialization request without a session ID." }));
      return;
    }

    // No session ID → new session (initialization request)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid: string) => {
        sessions.set(sid, { server, transport });
        insight.info(`HTTP session initialized: ${sid.slice(0, 8)}...`);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        sessions.delete(sid);
        insight.detail(`HTTP session closed: ${sid.slice(0, 8)}...`);
      }
    };

    const server = createAgoraServer(config);
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  httpServer.listen(config.httpPort, () => {
    insight.info(`HTTP transport listening on http://localhost:${config.httpPort}/mcp`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    insight.info("Shutting down HTTP server...");
    for (const [, session] of sessions) {
      await session.transport.close();
    }
    httpServer.close();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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

  // Generate MCP client configs
  const mcpConfig = JSON.stringify({
    mcpServers: {
      agora: {
        command: "npx",
        args: ["-y", "agora-mcp@latest", "serve", "--repo-path", repoRoot],
      },
    },
  }, null, 2) + "\n";

  const mcpConfigPath = join(agoraDir, "mcp-config.json");
  if (!existsSync(mcpConfigPath)) {
    writeFileSync(mcpConfigPath, mcpConfig);
    insight.info(`Created ${mcpConfigPath} — copy into your MCP client config`);
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
  console.error("  --repo-path      Repository path (default: cwd)");
  console.error("  --transport      stdio | http (default: stdio)");
  console.error("  --http-port      HTTP transport port (default: 3000)");
  console.error("  --verbosity      quiet | normal | verbose");
  console.error("  --no-dashboard   Disable the admin dashboard");
  console.error("  --debug-logging  Enable raw payload capture");
  console.error("  --version, -v    Show version");
  console.error("  --help, -h       Show help");
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
