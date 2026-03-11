import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "./core/constants.js";
import type { AgoraConfig } from "./core/config.js";
import type { AgoraContext } from "./core/context.js";
import { initDatabase, initGlobalDatabase } from "./db/init.js";
import * as queries from "./db/queries.js";
import { prepareKnowledgeSearchTarget } from "./knowledge/search.js";
import { SearchRouter } from "./search/router.js";
import { InsightStream } from "./core/insight-stream.js";
import { isGitRepo, getRepoRoot, getMainRepoRoot } from "./git/operations.js";
import { CoordinationBus } from "./coordination/bus.js";
import { basename } from "node:path";
import { registerReadTools } from "./tools/read-tools.js";
import { registerIndexTools } from "./tools/index-tools.js";
import { registerAgentTools } from "./tools/agent-tools.js";
import { registerPatchTools } from "./tools/patch-tools.js";
import { registerNoteTools } from "./tools/note-tools.js";
import { registerCoordinationTools } from "./tools/coordination-tools.js";
import { registerKnowledgeTools } from "./tools/knowledge-tools.js";
import { registerTicketTools } from "./tools/ticket-tools.js";
import { installToolRuntimeInstrumentation } from "./tools/runtime-instrumentation.js";

export function createAgoraServer(config: AgoraConfig) {
  const server = new McpServer({
    name: "agora",
    version: VERSION,
  });

  const insight = new InsightStream(config.verbosity);
  let ctx: AgoraContext | null = null;

  async function getContext(): Promise<AgoraContext> {
    if (ctx) return ctx;

    if (!(await isGitRepo({ cwd: config.repoPath }))) {
      throw new Error(`Not a git repository: ${config.repoPath}`);
    }

    const repoRoot = await getRepoRoot({ cwd: config.repoPath });
    const mainRepoRoot = await getMainRepoRoot({ cwd: config.repoPath });
    const repoName = basename(repoRoot);

    const { db, sqlite } = initDatabase({
      repoPath: mainRepoRoot,
      agoraDir: config.agoraDir,
      dbName: config.dbName,
    });

    const { id: repoId } = queries.upsertRepo(db, repoRoot, repoName);

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

    const bus = new CoordinationBus(config.coordinationTopology ?? "hub-spoke", 200, db, repoId);

    // Global knowledge DB (~/.agora/knowledge.db)
    let globalDb: AgoraContext["globalDb"] = null;
    let globalSqlite: AgoraContext["globalSqlite"] = null;
    try {
      const globalResult = initGlobalDatabase();
      globalDb = globalResult.globalDb;
      globalSqlite = globalResult.globalSqlite;
      if (globalSqlite) {
        prepareKnowledgeSearchTarget(searchRouter, globalSqlite);
      }
    } catch (err) {
      insight.warn(`Global knowledge DB init failed: ${err}`);
    }

    ctx = { config, db, sqlite, repoId, repoPath: repoRoot, searchRouter, insight, bus, globalDb, globalSqlite };
    insight.info(`Initialized for ${repoRoot} (search: ${searchRouter.getActiveBackendName()})`);
    return ctx;
  }

  installToolRuntimeInstrumentation(server, getContext);

  // Register tool groups
  registerReadTools(server, getContext);
  registerIndexTools(server, getContext);
  registerAgentTools(server, getContext);
  registerPatchTools(server, getContext);
  registerNoteTools(server, getContext);
  registerCoordinationTools(server, getContext);
  registerKnowledgeTools(server, getContext);
  registerTicketTools(server, getContext);

  return server;
}
