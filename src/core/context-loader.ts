import { basename } from "node:path";
import type { MonstheraConfig } from "./config.js";
import type { MonstheraContext } from "./context.js";
import { migrateFromAgora, migrateGlobalFromAgora } from "./migration.js";
import { initDatabase, initGlobalDatabase } from "../db/init.js";
import * as queries from "../db/queries.js";
import { prepareKnowledgeSearchTarget } from "../knowledge/search.js";
import { SearchRouter } from "../search/router.js";
import { InsightStream } from "./insight-stream.js";
import { isGitRepo, getRepoRoot, getMainRepoRoot } from "../git/operations.js";
import { CoordinationBus } from "../coordination/bus.js";
import { TicketLifecycleReactor } from "../tickets/lifecycle.js";

export interface ContextLoaderOptions {
  startLifecycleSweep?: boolean;
}

export function createMonstheraContextLoader(
  config: MonstheraConfig,
  insight: InsightStream,
  options: ContextLoaderOptions = {},
): () => Promise<MonstheraContext> {
  let ctx: MonstheraContext | null = null;
  let lifecycleSweepTimer: ReturnType<typeof setInterval> | null = null;

  return async function getContext(): Promise<MonstheraContext> {
    if (ctx) return ctx;

    // Migrate legacy .agora/ directory if present
    migrateFromAgora(config.repoPath, (msg) => insight.info(msg));
    migrateGlobalFromAgora((msg) => insight.info(msg));

    if (!(await isGitRepo({ cwd: config.repoPath }))) {
      throw new Error(`Not a git repository: ${config.repoPath}`);
    }

    const repoRoot = await getRepoRoot({ cwd: config.repoPath });
    const mainRepoRoot = await getMainRepoRoot({ cwd: config.repoPath });
    const repoName = basename(repoRoot);

    const { db, sqlite } = initDatabase({
      repoPath: mainRepoRoot,
      monstheraDir: config.monstheraDir,
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
      indexDir: `${mainRepoRoot}/${config.monstheraDir}`,
      onFallback: (reason) => insight.warn(reason),
    });
    await searchRouter.initialize();

    const bus = new CoordinationBus(config.coordinationTopology ?? "hub-spoke", 200, db, repoId);

    let globalDb: MonstheraContext["globalDb"] = null;
    let globalSqlite: MonstheraContext["globalSqlite"] = null;
    try {
      const globalResult = initGlobalDatabase();
      globalDb = globalResult.globalDb;
      globalSqlite = globalResult.globalSqlite;
      if (globalSqlite) {
        prepareKnowledgeSearchTarget(searchRouter, globalSqlite);
        // Backfill global knowledge embeddings in background
        searchRouter.backfillKnowledgeEmbeddings(globalSqlite).catch(() => {});
      }
    } catch (err) {
      insight.warn(`Global knowledge DB init failed: ${err}`);
    }

    let lifecycle: TicketLifecycleReactor | undefined;
    if (config.lifecycle?.enabled) {
      lifecycle = new TicketLifecycleReactor({ config, db, sqlite, repoId, repoPath: repoRoot, insight, searchRouter, bus });
      if (options.startLifecycleSweep !== false) {
        lifecycleSweepTimer = setInterval(() => {
          try { lifecycle!.sweep(); }
          catch (e) { insight.warn(`Lifecycle sweep failed: ${e}`); }
        }, config.lifecycle.sweepIntervalMs);
        lifecycleSweepTimer.unref?.();
        insight.info(`Lifecycle automation enabled (sweep interval: ${config.lifecycle.sweepIntervalMs}ms)`);
      } else {
        insight.info("Lifecycle automation enabled without background sweep for one-shot runtime");
      }
    }

    ctx = {
      config,
      db,
      sqlite,
      repoId,
      repoPath: repoRoot,
      searchRouter,
      insight,
      bus,
      globalDb,
      globalSqlite,
      lifecycle,
      dispose: () => {
        if (!lifecycleSweepTimer) return;
        clearInterval(lifecycleSweepTimer);
        lifecycleSweepTimer = null;
      },
    };
    insight.info(`Initialized for ${repoRoot} (search: ${searchRouter.getActiveBackendName()})`);
    return ctx;
  };
}
