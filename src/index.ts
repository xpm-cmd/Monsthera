import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgoraServer } from "./server.js";
import { loadConfigFile, mergeConfigSources, resolveConfig, type AgoraConfig } from "./core/config.js";
import { VERSION } from "./core/constants.js";
import { createAgoraContextLoader } from "./core/context-loader.js";
import { recordRuntimeEventWithContext } from "./tools/runtime-instrumentation.js";
import { initDatabase, initGlobalDatabase } from "./db/init.js";
import { InsightStream } from "./core/insight-stream.js";
import { fullIndex, getIndexedCommit, incrementalIndex, buildIndexOptions } from "./indexing/indexer.js";
import { isGitRepo, getRepoRoot, getMainRepoRoot } from "./git/operations.js";
import * as queries from "./db/queries.js";
import { prepareKnowledgeSearchTarget } from "./knowledge/search.js";
import { basename, join } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { compileSecretPatterns } from "./trust/secret-patterns.js";
import { CrossInstanceNonceStore } from "./trust/cross-instance-nonce-store.js";
import { validateCrossInstanceRequest } from "./trust/cross-instance-request-guard.js";
import { cmdTicket } from "./cli/tickets.js";
import { cmdPatch } from "./cli/patches.js";
import { cmdKnowledge } from "./cli/knowledge.js";
import { cmdLoop } from "./cli/loops.js";
import { cmdTool } from "./cli/tools.js";
import {
  CROSS_INSTANCE_SEARCH_PATH,
  CrossInstanceSearchRequestSchema,
  getCrossInstanceCapabilityTool,
  runLocalCrossInstanceSearch,
} from "./federation/search.js";

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  // Precedence: CLI flags > env vars > config file > Zod defaults
  const repoPath = getArg(args, "--repo-path") ?? process.env.AGORA_REPO_PATH ?? process.cwd();
  const fileConfig = loadConfigFile(repoPath);
  const envConfig = buildEnvConfig();
  const cliConfig = buildCliConfig(args);

  if (args.includes("--version") || args.includes("-v")) {
    console.error(`agora v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h") || command === "help") {
    printHelp();
    process.exit(0);
  }

  const config = resolveConfig({
    ...mergeConfigSources(fileConfig, envConfig, cliConfig),
    repoPath,
  });
  const insight = new InsightStream(config.verbosity);

  switch (command) {
    case "init":
      await cmdInit(config, insight);
      break;
    case "index":
      await cmdIndex(config, insight, args.slice(1));
      break;
    case "status":
      await cmdStatus(config, insight);
      break;
    case "export":
      await cmdExport(config, insight, args);
      break;
    case "ticket":
    case "tickets":
      await cmdTicket(config, insight, args.slice(1));
      break;
    case "patch":
    case "patches":
      await cmdPatch(config, insight, args.slice(1));
      break;
    case "knowledge":
      await cmdKnowledge(config, insight, args.slice(1));
      break;
    case "tool":
    case "tools":
      await cmdTool(config, insight, args.slice(1));
      break;
    case "loop":
    case "loops":
      await cmdLoop(config, insight, args.slice(1));
      break;
    case "facilitator":
      await cmdLoop(config, insight, ["plan", ...args.slice(1)]);
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
      const mainRepoRoot = await getMainRepoRoot({ cwd: config.repoPath });
      const repoName = basename(repoRoot);
      const { db, sqlite } = initDatabase({ repoPath: mainRepoRoot, agoraDir: config.agoraDir, dbName: config.dbName });
      const { id: repoId } = queries.upsertRepo(db, repoRoot, repoName);
      const { CoordinationBus } = await import("./coordination/bus.js");
      const { SearchRouter } = await import("./search/router.js");
      const { buildCodeSearchDebug } = await import("./search/debug.js");
      const { searchKnowledgeEntries } = await import("./knowledge/search.js");
      const { startDashboard } = await import("./dashboard/server.js");
      const bus = new CoordinationBus(config.coordinationTopology ?? "hub-spoke", 200, db, repoId);
      const searchRouter = new SearchRouter({
        repoId,
        sqlite,
        db,
        repoPath: repoRoot,
        zoektEnabled: config.zoektEnabled,
        semanticEnabled: config.semanticEnabled,
        searchConfig: config.search,
        indexDir: `${mainRepoRoot}/${config.agoraDir}`,
        onFallback: (reason) => insight.warn(reason),
      });
      await searchRouter.initialize();
      let globalDb = null;
      let globalSqlite = null;
      try {
        const globalResult = initGlobalDatabase();
        globalDb = globalResult.globalDb;
        globalSqlite = globalResult.globalSqlite;
        if (globalSqlite) {
          prepareKnowledgeSearchTarget(searchRouter, globalSqlite);
        }
      } catch { /* non-fatal */ }
      startDashboard({
        db,
        repoId,
        repoPath: repoRoot,
        mainRepoPath: mainRepoRoot,
        bus,
        globalDb,
        ticketQuorum: config.ticketQuorum,
        governance: config.governance,
        knowledgeSearch: (params) => searchKnowledgeEntries({
          db,
          sqlite,
          globalDb,
          globalSqlite,
          searchRouter,
        }, params),
        refreshTicketSearch: () => searchRouter.rebuildTicketFts(repoId),
        refreshKnowledgeSearch: (knowledgeIds?: number[]) => {
          if (knowledgeIds && knowledgeIds.length > 0) {
            for (const knowledgeId of knowledgeIds) {
              searchRouter.upsertKnowledgeFts(sqlite, knowledgeId);
            }
            return;
          }
          searchRouter.rebuildKnowledgeFts(sqlite);
        },
        searchDebug: {
          searchCode: (params) => buildCodeSearchDebug({
            sqlite,
            db,
            repoId,
            runtimeBackend: searchRouter.getActiveBackendName(),
            lexicalBackend: searchRouter.getLexicalBackendName(),
            lexicalSearch: (query, targetRepoId, limit, scope) =>
              searchRouter.searchLexical(query, targetRepoId, limit, scope),
            semanticReranker: searchRouter.getSemanticReranker(),
            andQueryTermCount: config.search.thresholds.andQueryTermCount,
            semanticBlendAlpha: config.search.semanticBlendAlpha,
          }, params),
        },
      }, config.dashboardPort, insight);

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
  const getContext = createAgoraContextLoader(config, insight);
  const nonceStore = new CrossInstanceNonceStore(config.crossInstance.nonceTtlSeconds * 1000);

  // Map of sessionId → { server, transport }
  const sessions = new Map<string, { server: ReturnType<typeof createAgoraServer>; transport: InstanceType<typeof StreamableHTTPServerTransport> }>();

  const MCP_CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, X-Agora-Instance-Id, X-Agora-Timestamp, X-Agora-Nonce, X-Agora-Signature",
    "Access-Control-Expose-Headers": "mcp-session-id",
    "X-Content-Type-Options": "nosniff",
  };

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${config.httpPort}`);

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, MCP_CORS_HEADERS);
      res.end();
      return;
    }

    if (url.pathname === CROSS_INSTANCE_SEARCH_PATH) {
      if (req.method !== "POST") {
        res.writeHead(405, { ...MCP_CORS_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      const startedAt = Date.now();
      const body = await readRequestBody(req);
      const bodyText = body.toString("utf-8");
      const headerInstanceId = typeof req.headers["x-agora-instance-id"] === "string"
        ? req.headers["x-agora-instance-id"].trim()
        : "unknown";

      if (!config.crossInstance.enabled) {
        const ctx = await getContext();
        await recordRuntimeEventWithContext(ctx, {
          tool: "cross_instance.search.disabled",
          input: { path: url.pathname, body: bodyText },
          output: "cross_instance_disabled",
          status: "denied",
          durationMs: Date.now() - startedAt,
          denialReason: "cross_instance_disabled",
          errorCode: "cross_instance_disabled",
          errorDetail: "Cross-instance search request rejected because crossInstance is disabled",
          agentId: `system:peer-${headerInstanceId || "unknown"}`,
          sessionId: "system",
        });
        res.writeHead(404, { ...MCP_CORS_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Cross-instance search is disabled" }));
        return;
      }

      const parsed = CrossInstanceSearchRequestSchema.safeParse(tryParseJson(bodyText));
      if (!parsed.success) {
        const ctx = await getContext();
        await recordRuntimeEventWithContext(ctx, {
          tool: "cross_instance.search.invalid_request",
          input: { path: url.pathname, body: bodyText },
          output: "invalid_request",
          status: "error",
          durationMs: Date.now() - startedAt,
          errorCode: "invalid_request",
          errorDetail: parsed.error.message,
          agentId: `system:peer-${headerInstanceId || "unknown"}`,
          sessionId: "system",
        });
        res.writeHead(400, { ...MCP_CORS_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid cross-instance search payload" }));
        return;
      }

      const request = parsed.data;
      const ctx = await getContext();
      const validation = validateCrossInstanceRequest({
        crossInstance: {
          peers: config.crossInstance.peers,
          timestampSkewSeconds: config.crossInstance.timestampSkewSeconds,
        },
        nonceStore,
        tool: getCrossInstanceCapabilityTool(request.surface),
        method: req.method,
        path: url.pathname,
        query: url.searchParams,
        body,
        headers: req.headers,
      });

      if (!validation.ok) {
        await recordRuntimeEventWithContext(ctx, {
          tool: `cross_instance.search.${request.surface}`,
          input: { path: url.pathname, request },
          output: validation.reason,
          status: "denied",
          durationMs: Date.now() - startedAt,
          denialReason: validation.reason,
          errorCode: validation.reason,
          errorDetail: `Cross-instance search rejected for ${headerInstanceId || "unknown"}`,
          agentId: `system:peer-${headerInstanceId || "unknown"}`,
          sessionId: "system",
        });
        res.writeHead(crossInstanceHttpStatus(validation.reason), { ...MCP_CORS_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: validation.reason }));
        return;
      }

      try {
        const result = await runLocalCrossInstanceSearch(ctx, request);
        await recordRuntimeEventWithContext(ctx, {
          tool: `cross_instance.search.${request.surface}`,
          input: { path: url.pathname, request },
          output: JSON.stringify({ count: result.count, instanceId: result.instanceId }),
          status: "success",
          durationMs: Date.now() - startedAt,
          agentId: `system:peer-${validation.instanceId}`,
          sessionId: "system",
        });
        res.writeHead(200, { ...MCP_CORS_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        await recordRuntimeEventWithContext(ctx, {
          tool: `cross_instance.search.${request.surface}`,
          input: { path: url.pathname, request },
          output: error instanceof Error ? error.message : String(error),
          status: "error",
          durationMs: Date.now() - startedAt,
          errorCode: "cross_instance_search_failed",
          errorDetail: error instanceof Error ? error.stack ?? error.message : String(error),
          agentId: `system:peer-${validation.instanceId}`,
          sessionId: "system",
        });
        res.writeHead(500, { ...MCP_CORS_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Cross-instance search failed" }));
      }
      return;
    }

    // Only handle /mcp endpoint
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { ...MCP_CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Not found. Use /mcp or ${CROSS_INSTANCE_SEARCH_PATH}.` }));
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
      res.writeHead(404, { ...MCP_CORS_HEADERS, "Content-Type": "application/json" });
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

    const server = createAgoraServer(config, { insight, getContext });
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

async function readRequestBody(req: import("node:http").IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function crossInstanceHttpStatus(reason: string): number {
  switch (reason) {
    case "capability_not_allowed":
      return 403;
    case "replayed_nonce":
      return 409;
    default:
      return 401;
  }
}

async function cmdInit(config: ReturnType<typeof resolveConfig>, insight: InsightStream) {
  if (!(await isGitRepo({ cwd: config.repoPath }))) {
    insight.error("Not a git repository");
    process.exit(1);
  }

  const mainRepoRoot = await getMainRepoRoot({ cwd: config.repoPath });
  const agoraDir = join(mainRepoRoot, config.agoraDir);

  mkdirSync(agoraDir, { recursive: true });

  const configPath = join(agoraDir, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify({
      zoektEnabled: true,
      semanticEnabled: true,
      coordinationTopology: "hub-spoke",
      sensitiveFilePatterns: [".env", ".env.*", "*.key", "*.pem", "credentials.*", "secrets.*"],
      secretPatterns: [],
      registrationAuth: {
        enabled: false,
        observerOpenRegistration: true,
        roleTokens: {},
      },
      crossInstance: {
        enabled: false,
        peers: [],
      },
    }, null, 2) + "\n");
    insight.info(`Created ${configPath}`);
  }

  // Initialize database
  initDatabase({ repoPath: mainRepoRoot, agoraDir: config.agoraDir, dbName: config.dbName });
  insight.info(`Initialized Agora in ${agoraDir}`);

  // Add .agora to .gitignore if not already there
  const gitignorePath = join(mainRepoRoot, ".gitignore");
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
        args: ["-y", "agora-mcp@latest", "serve", "--repo-path", mainRepoRoot],
      },
    },
  }, null, 2) + "\n";

  const mcpConfigPath = join(agoraDir, "mcp-config.json");
  if (!existsSync(mcpConfigPath)) {
    writeFileSync(mcpConfigPath, mcpConfig);
    insight.info(`Created ${mcpConfigPath} — copy into your MCP client config`);
  }
}

async function cmdIndex(
  config: ReturnType<typeof resolveConfig>,
  insight: InsightStream,
  args: string[] = [],
) {
  if (!(await isGitRepo({ cwd: config.repoPath }))) {
    insight.error("Not a git repository");
    process.exit(1);
  }

  const forceFull = args.includes("--full");
  const preferIncremental = args.includes("--incremental");
  if (forceFull && preferIncremental) {
    insight.error("Use only one of --full or --incremental");
    process.exit(1);
  }

  const repoRoot = await getRepoRoot({ cwd: config.repoPath });
  const mainRepoRoot = await getMainRepoRoot({ cwd: config.repoPath });
  const repoName = basename(repoRoot);
  const { db, sqlite } = initDatabase({ repoPath: mainRepoRoot, agoraDir: config.agoraDir, dbName: config.dbName });
  const { id: repoId } = queries.upsertRepo(db, repoRoot, repoName);
  const indexedCommit = getIndexedCommit(db, repoId);

  // Initialize semantic reranker if enabled (generates embeddings during indexing)
  let semanticReranker: import("./search/semantic.js").SemanticReranker | null = null;
  if (config.semanticEnabled) {
    try {
      const { SemanticReranker } = await import("./search/semantic.js");
      semanticReranker = new SemanticReranker({ sqlite, db, onFallback: (r) => insight.warn(r) });
      const ok = await semanticReranker.initialize();
      if (ok) {
        insight.info("Semantic model loaded — embeddings will be generated during indexing");
      } else {
        insight.warn("Semantic model failed to load — indexing without embeddings");
        semanticReranker = null;
      }
    } catch (err) {
      insight.warn(`Semantic init error: ${err}`);
    }
  }

  const shouldRunIncremental = Boolean(preferIncremental && indexedCommit);
  if (preferIncremental && !indexedCommit) {
    insight.warn("No previous indexed commit found; falling back to full index");
  }

  const indexOpts = buildIndexOptions({
    repoPath: repoRoot,
    repoId,
    db,
    sensitiveFilePatterns: config.sensitiveFilePatterns,
    secretPatterns: compileSecretPatterns(config.secretPatterns),
    excludePatterns: config.excludePatterns,
    onProgress: (msg: string) => insight.detail(msg),
    semanticReranker,
  });

  insight.info(shouldRunIncremental ? `Starting incremental index from ${indexedCommit!.slice(0, 7)}...` : "Starting full index...");
  const result = shouldRunIncremental
    ? await incrementalIndex(indexedCommit!, indexOpts)
    : await fullIndex(indexOpts);

  await rebuildSearchIndexes(sqlite, db, repoId, insight);

  insight.info(`Done: ${result.filesIndexed} files indexed at ${result.commit.slice(0, 7)} (${result.durationMs}ms)`);
  if (result.errors.length > 0) {
    insight.warn(`${result.errors.length} errors during indexing`);
  }
}

async function rebuildSearchIndexes(
  sqlite: ReturnType<typeof initDatabase>["sqlite"],
  db: ReturnType<typeof initDatabase>["db"],
  repoId: number,
  insight: InsightStream,
) {
  try {
    const { FTS5Backend } = await import("./search/fts5.js");
    const fts5 = new FTS5Backend(sqlite, db, (reason) => insight.warn(reason));
    fts5.initFtsTable();
    fts5.rebuildIndex(repoId);
    fts5.initKnowledgeFts(sqlite);
    fts5.rebuildKnowledgeFts(sqlite);
    fts5.initTicketFts();
    fts5.rebuildTicketFts(repoId);
    try {
      const { globalSqlite } = initGlobalDatabase();
      if (globalSqlite) {
        fts5.initKnowledgeFts(globalSqlite);
        fts5.rebuildKnowledgeFts(globalSqlite);
      }
    } catch {
      // global DB may not exist
    }
  } catch {
    // non-fatal: FTS5 will be created on next serve
  }
}

async function cmdStatus(config: ReturnType<typeof resolveConfig>, insight: InsightStream) {
  if (!(await isGitRepo({ cwd: config.repoPath }))) {
    insight.error("Not a git repository");
    process.exit(1);
  }

  const repoRoot = await getRepoRoot({ cwd: config.repoPath });
  const mainRepoRoot = await getMainRepoRoot({ cwd: config.repoPath });
  const repoName = basename(repoRoot);
  const { db } = initDatabase({ repoPath: mainRepoRoot, agoraDir: config.agoraDir, dbName: config.dbName });
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

async function cmdExport(config: ReturnType<typeof resolveConfig>, insight: InsightStream, args: string[]) {
  if (!args.includes("--obsidian")) {
    insight.error("Specify export format: --obsidian");
    process.exit(1);
  }

  if (!(await isGitRepo({ cwd: config.repoPath }))) {
    insight.error("Not a git repository");
    process.exit(1);
  }

  const repoRoot = await getRepoRoot({ cwd: config.repoPath });
  const mainRepoRoot = await getMainRepoRoot({ cwd: config.repoPath });
  const { db } = initDatabase({ repoPath: mainRepoRoot, agoraDir: config.agoraDir, dbName: config.dbName });

  let globalDb = null;
  try { globalDb = initGlobalDatabase().globalDb; } catch { /* non-fatal */ }

  const vaultPath = getArg(args, "--vault") ?? repoRoot;

  const { exportToObsidian } = await import("./export/obsidian.js");
  const result = exportToObsidian({ vaultPath, repoDb: db, globalDb });
  insight.info(`Exported ${result.exported} knowledge entries to ${result.path}`);
}

function printHelp() {
  console.error(`agora v${VERSION} — Multi-agent shared context server`);
  console.error("");
  console.error("Commands:");
  console.error("  serve          Start MCP server (default)");
  console.error("  init           Initialize .agora directory");
  console.error("  index          Run code index (--incremental or --full)");
  console.error("  status         Show index status");
  console.error("  export         Export knowledge to external tools");
  console.error("  ticket         Repo-scoped ticket operations");
  console.error("  patch          Repo-scoped patch inspection");
  console.error("  knowledge      Repo/global knowledge inspection");
  console.error("  loop           Run a repo-local planner/developer/council workflow");
  console.error("  facilitator    Alias for `agora loop plan`");
  console.error("  tool           Invoke a local Agora MCP tool from CLI");
  console.error("");
  console.error("Options:");
  console.error("  --repo-path      Repository path (default: cwd)");
  console.error("  --transport      stdio | http (default: stdio)");
  console.error("  --http-port      HTTP transport port (default: 3000)");
  console.error("  --dashboard-port Dashboard UI port (default: 3141)");
  console.error("  --verbosity      quiet | normal | verbose");
  console.error("  --no-dashboard   Disable the admin dashboard");
  console.error("  --semantic       Enable semantic/hybrid search");
  console.error("  --no-semantic    Disable semantic/hybrid search");
  console.error("  --debug-logging  Enable raw payload capture");
  console.error("  --obsidian       Export as Obsidian markdown vault");
  console.error("  --vault          Obsidian vault path (default: repo root)");
  console.error("  --version, -v    Show version");
  console.error("  --help, -h       Show help");
  console.error("");
  console.error("Ticket examples:");
  console.error("  agora ticket summary --json");
  console.error("  agora index --incremental");
  console.error("  agora ticket list --status in_progress");
  console.error("  agora ticket show TKT-1234abcd --json");
  console.error("  agora ticket transition TKT-1234abcd in_review --comment \"Implementation complete\"");
  console.error("  agora ticket reconcile-commit --json");
  console.error("  agora patch summary --json");
  console.error("  agora patch show patch_abcd1234 --json");
  console.error("  agora knowledge query --scope all --type decision --json");
  console.error("  agora knowledge search \"shared auth\" --scope all --json");
  console.error("  agora knowledge show decision:abc123 --scope all --json");
  console.error("  agora tool list");
  console.error("  agora tool inspect propose_patch --json");
  console.error("  agora tool status --json");
  console.error("  agora tool claim_files --input '{\"agentId\":\"agent-dev\",\"sessionId\":\"session-dev\",\"paths\":[\"src/index.ts\"]}' --json");
  console.error("  agora loop plan --json");
  console.error("  agora loop dev --limit 3 --json");
  console.error("  agora loop council TKT-1234abcd --transition in_review->ready_for_commit --json");
  console.error("  agora facilitator --watch");
  console.error("");
  console.error("Git hooks:");
  console.error("  post-commit    Auto-runs 'ticket reconcile-commit' and 'index --incremental'");
  console.error("                 in background. Requires .agora/ dir (skipped otherwise).");
  console.error("");
  console.error("Agent access preference:");
  console.error("  Prefer `agora ticket|patch|knowledge ... --json` or `agora tool ... --json`");
  console.error("  before reading `.agora/agora.db` directly.");
  console.error("");
  console.error("Environment Variables (overridden by CLI flags):");
  console.error("  AGORA_REPO_PATH       Repository path");
  console.error("  AGORA_VERBOSITY       quiet | normal | verbose");
  console.error("  AGORA_TRANSPORT       stdio | http");
  console.error("  AGORA_HTTP_PORT       HTTP transport port");
  console.error("  AGORA_DASHBOARD_PORT  Dashboard UI port");
  console.error("  AGORA_SEMANTIC        true | false");
  console.error("  AGORA_DEBUG_LOGGING   true | false");
  console.error("  AGORA_NO_DASHBOARD    true | false");
  console.error("  AGORA_REGISTRATION_AUTH        true | false");
  console.error("  AGORA_OBSERVER_OPEN_REGISTRATION true | false");
  console.error("  AGORA_ROLE_TOKEN_DEVELOPER     Registration token for developer");
  console.error("  AGORA_ROLE_TOKEN_REVIEWER      Registration token for reviewer");
  console.error("  AGORA_ROLE_TOKEN_OBSERVER      Registration token for observer");
  console.error("  AGORA_ROLE_TOKEN_ADMIN         Registration token for admin");
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

function buildEnvConfig(): Partial<AgoraConfig> {
  const envConfig: Partial<AgoraConfig> = {};

  if (process.env.AGORA_VERBOSITY) {
    envConfig.verbosity = process.env.AGORA_VERBOSITY as AgoraConfig["verbosity"];
  }
  if (process.env.AGORA_TRANSPORT) {
    envConfig.transport = process.env.AGORA_TRANSPORT as AgoraConfig["transport"];
  }
  if (process.env.AGORA_HTTP_PORT) {
    envConfig.httpPort = parseInt(process.env.AGORA_HTTP_PORT, 10);
  }
  if (process.env.AGORA_DASHBOARD_PORT) {
    envConfig.dashboardPort = parseInt(process.env.AGORA_DASHBOARD_PORT, 10);
  }

  const debugLogging = parseBooleanEnv("AGORA_DEBUG_LOGGING");
  if (debugLogging !== undefined) {
    envConfig.debugLogging = debugLogging;
  }

  const noDashboard = parseBooleanEnv("AGORA_NO_DASHBOARD");
  if (noDashboard !== undefined) {
    envConfig.noDashboard = noDashboard;
  }

  const semanticEnabled = parseBooleanEnv("AGORA_SEMANTIC");
  if (semanticEnabled !== undefined) {
    envConfig.semanticEnabled = semanticEnabled;
  }

  const registrationAuthEnabled = parseBooleanEnv("AGORA_REGISTRATION_AUTH");
  const observerOpenRegistration = parseBooleanEnv("AGORA_OBSERVER_OPEN_REGISTRATION");
  const roleTokens = {
    ...(process.env.AGORA_ROLE_TOKEN_DEVELOPER ? { developer: process.env.AGORA_ROLE_TOKEN_DEVELOPER } : {}),
    ...(process.env.AGORA_ROLE_TOKEN_REVIEWER ? { reviewer: process.env.AGORA_ROLE_TOKEN_REVIEWER } : {}),
    ...(process.env.AGORA_ROLE_TOKEN_OBSERVER ? { observer: process.env.AGORA_ROLE_TOKEN_OBSERVER } : {}),
    ...(process.env.AGORA_ROLE_TOKEN_ADMIN ? { admin: process.env.AGORA_ROLE_TOKEN_ADMIN } : {}),
  };
  if (
    registrationAuthEnabled !== undefined
    || observerOpenRegistration !== undefined
    || Object.keys(roleTokens).length > 0
  ) {
    const registrationAuth: Partial<AgoraConfig["registrationAuth"]> = {};
    if (registrationAuthEnabled !== undefined) {
      registrationAuth.enabled = registrationAuthEnabled;
    }
    if (observerOpenRegistration !== undefined) {
      registrationAuth.observerOpenRegistration = observerOpenRegistration;
    }
    if (Object.keys(roleTokens).length > 0) {
      registrationAuth.roleTokens = roleTokens;
    }
    envConfig.registrationAuth = registrationAuth as AgoraConfig["registrationAuth"];
  }

  return envConfig;
}

function buildCliConfig(args: string[]): Partial<AgoraConfig> {
  const cliConfig: Partial<AgoraConfig> = {};

  const verbosity = getArg(args, "--verbosity");
  if (verbosity) {
    cliConfig.verbosity = verbosity as AgoraConfig["verbosity"];
  }

  const transport = getArg(args, "--transport");
  if (transport) {
    cliConfig.transport = transport as AgoraConfig["transport"];
  }

  const httpPort = getArg(args, "--http-port");
  if (httpPort) {
    cliConfig.httpPort = parseInt(httpPort, 10);
  }

  const dashboardPort = getArg(args, "--dashboard-port");
  if (dashboardPort) {
    cliConfig.dashboardPort = parseInt(dashboardPort, 10);
  }

  if (args.includes("--debug-logging")) {
    cliConfig.debugLogging = true;
  }
  if (args.includes("--no-dashboard")) {
    cliConfig.noDashboard = true;
  }
  if (args.includes("--semantic")) {
    cliConfig.semanticEnabled = true;
  }
  if (args.includes("--no-semantic")) {
    cliConfig.semanticEnabled = false;
  }

  return cliConfig;
}

function parseBooleanEnv(name: string): boolean | undefined {
  const value = process.env[name];
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

main().catch((err) => {
  console.error("[AGORA] Fatal error:", err);
  process.exit(1);
});
