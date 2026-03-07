import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { VERSION, SUPPORTED_LANGUAGES } from "./core/constants.js";
import type { AgoraConfig } from "./core/config.js";
import type { AgoraContext } from "./core/context.js";
import { initDatabase } from "./db/init.js";
import * as queries from "./db/queries.js";
import { SearchRouter } from "./search/router.js";
import { InsightStream } from "./core/insight-stream.js";
import { fullIndex, incrementalIndex, getIndexedCommit } from "./indexing/indexer.js";
import { buildEvidenceBundle } from "./retrieval/evidence-bundle.js";
import { getHead, getChangedFiles, getRecentCommits, isGitRepo, getRepoRoot } from "./git/operations.js";
import { basename } from "node:path";
import { registerReadTools } from "./tools/read-tools.js";
import { registerIndexTools } from "./tools/index-tools.js";

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
    const repoName = basename(repoRoot);

    const { db, sqlite } = initDatabase({
      repoPath: repoRoot,
      agoraDir: config.agoraDir,
      dbName: config.dbName,
    });

    const { id: repoId } = queries.upsertRepo(db, repoRoot, repoName);

    const searchRouter = new SearchRouter({
      sqlite,
      db,
      repoPath: repoRoot,
      zoektEnabled: config.zoektEnabled,
      indexDir: `${repoRoot}/${config.agoraDir}`,
      onFallback: (reason) => insight.warn(reason),
    });
    await searchRouter.initialize();

    ctx = { config, db, sqlite, repoId, repoPath: repoRoot, searchRouter, insight };
    insight.info(`Initialized for ${repoRoot} (search: ${searchRouter.getActiveBackendName()})`);
    return ctx;
  }

  // Register tool groups
  registerReadTools(server, getContext);
  registerIndexTools(server, getContext);

  return server;
}
