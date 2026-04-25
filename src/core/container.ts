import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { MonstheraConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { StatusReporter } from "./status.js";
import type { KnowledgeArticleRepository } from "../knowledge/repository.js";
import type { WorkArticleRepository } from "../work/repository.js";
import type { SearchIndexRepository } from "../search/repository.js";
import type { OrchestrationEventRepository } from "../orchestration/repository.js";
import type { ConvoyRepository } from "../orchestration/convoy-repository.js";
import type { Disposable } from "./lifecycle.js";

import { createLogger } from "./logger.js";
import { createStatusReporter } from "./status.js";
import { VERSION } from "./constants.js";
import { createRuntimeStateStore } from "./runtime-state.js";
import { DisposableStack } from "./lifecycle.js";
import { FileSystemKnowledgeArticleRepository } from "../knowledge/file-repository.js";
import { KnowledgeService } from "../knowledge/service.js";
import { FileSystemWorkArticleRepository } from "../work/file-repository.js";
import { WorkService } from "../work/service.js";
import { InMemorySearchIndexRepository } from "../search/in-memory-repository.js";
import { InMemoryOrchestrationEventRepository } from "../orchestration/in-memory-repository.js";
import { InMemoryConvoyRepository } from "../orchestration/in-memory-convoy-repository.js";
import { StubEmbeddingProvider, OllamaEmbeddingProvider } from "../search/embedding.js";
import type { EmbeddingProvider } from "../search/embedding.js";
import { SearchService } from "../search/service.js";
import { OrchestrationService } from "../orchestration/service.js";
import {
  AgentDispatcher,
  readDedupWindowFromEnv,
  readWorktreePathFromEnv,
} from "../orchestration/agent-dispatcher.js";
import { ResyncMonitor, readResyncIntervalFromEnv } from "../orchestration/resync-monitor.js";
import { PolicyLoader } from "../work/policy-loader.js";
import { MigrationService } from "../migration/service.js";
import type { V2SourceReader } from "../migration/types.js";
import { StructureService } from "../structure/service.js";
import { WikiBookkeeper } from "../knowledge/wiki-bookkeeper.js";
import { AgentService } from "../agents/service.js";
import { IngestService } from "../ingest/service.js";
import { InMemorySnapshotRepository } from "../context/snapshot-in-memory-repository.js";
import { SnapshotService } from "../context/snapshot-service.js";
import type { SnapshotRepository } from "../context/snapshot-repository.js";

/** The wired-up dependency container for the Monsthera runtime */
export interface MonstheraContainer extends Disposable {
  readonly config: MonstheraConfig;
  readonly logger: Logger;
  readonly status: StatusReporter;
  readonly knowledgeRepo: KnowledgeArticleRepository;
  readonly knowledgeService: KnowledgeService;
  readonly workRepo: WorkArticleRepository;
  readonly workService: WorkService;
  readonly searchRepo: SearchIndexRepository;
  readonly searchService: SearchService;
  readonly orchestrationRepo: OrchestrationEventRepository;
  readonly convoyRepo: ConvoyRepository;
  readonly orchestrationService: OrchestrationService;
  readonly agentDispatcher: AgentDispatcher;
  readonly resyncMonitor: ResyncMonitor;
  readonly structureService: StructureService;
  readonly agentsService: AgentService;
  readonly ingestService: IngestService;
  readonly migrationService?: MigrationService;
  readonly bookkeeper: WikiBookkeeper;
  readonly snapshotRepo: SnapshotRepository;
  readonly snapshotService: SnapshotService;
}

/**
 * Create the Monsthera runtime container.
 * Wires up all dependencies based on config.
 */
export async function createContainer(
  config: MonstheraConfig,
  options?: { v2Reader?: V2SourceReader },
): Promise<MonstheraContainer> {
  const stack = new DisposableStack();

  // Create logger based on verbosity
  const logLevel = config.verbosity === "quiet" ? "warn"
    : config.verbosity === "debug" ? "debug"
    : config.verbosity === "verbose" ? "debug"
    : "info";

  const logger = createLogger({ level: logLevel, domain: "monsthera" });

  // Create status reporter
  const status = createStatusReporter(VERSION);
  const runtimeState = createRuntimeStateStore(config.repoPath);

  let knowledgeRepo: KnowledgeArticleRepository | undefined;
  let workRepo: WorkArticleRepository | undefined;
  let searchRepo: SearchIndexRepository | undefined;
  let orchestrationRepo: OrchestrationEventRepository | undefined;
  let convoyRepo: ConvoyRepository | undefined;
  let snapshotRepo: SnapshotRepository | undefined;
  const markdownRoot = path.resolve(config.repoPath, config.storage.markdownRoot);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doltPool: any;

  knowledgeRepo = new FileSystemKnowledgeArticleRepository(markdownRoot);
  workRepo = new FileSystemWorkArticleRepository(markdownRoot);

  if (config.storage.doltEnabled) {
    try {
      const {
        createDoltPool,
        closePool,
        initializeSchema,
        monitorDoltHealth,
        DoltSearchIndexRepository,
        DoltOrchestrationRepository,
        DoltSnapshotRepository,
        DoltConvoyRepository,
      } = await import("../persistence/index.js");

      doltPool = createDoltPool({
        host: config.storage.doltHost,
        port: config.storage.doltPort,
        database: config.storage.doltDatabase,
        user: config.storage.doltUser,
        password: config.storage.doltPassword,
      });

      const schemaResult = await initializeSchema(doltPool);
      if (!schemaResult.ok) {
        logger.warn("Dolt schema initialization failed, falling back to in-memory storage", {
          error: schemaResult.error.message,
          domain: "persistence",
        });
        await closePool(doltPool);
        doltPool = undefined;
      } else {
        // Knowledge and Work repos stay FileSystem — Markdown is the source of truth.
        // Only search index, orchestration events, and snapshots (derived/ephemeral
        // state) move to Dolt.
        searchRepo = new DoltSearchIndexRepository(doltPool);
        orchestrationRepo = new DoltOrchestrationRepository(doltPool);
        snapshotRepo = new DoltSnapshotRepository(doltPool);
        convoyRepo = new DoltConvoyRepository(doltPool, { eventRepo: orchestrationRepo, logger });

        stack.defer(() => closePool(doltPool));

        status.register("storage", () => ({
          name: "storage",
          healthy: true,
          detail: `Markdown (${markdownRoot}) + Dolt index/events (${config.storage.doltHost}:${config.storage.doltPort}/${config.storage.doltDatabase})`,
        }));

        // Monitor Dolt health in the background, expose via status check
        let lastHealthy = true;
        let lastDetail = "Dolt connected";
        const stopMonitor = monitorDoltHealth(doltPool, {
          onHealthChange(health) {
            lastHealthy = health.healthy;
            lastDetail = health.healthy
              ? `Dolt OK (${health.latencyMs}ms, ${health.version ?? "unknown"})`
              : `Dolt unhealthy: ${health.error ?? "unknown error"}`;
          },
        });
        stack.defer(() => { stopMonitor(); });

        status.register("dolt-health", () => ({
          name: "dolt-health",
          healthy: lastHealthy,
          detail: lastDetail,
        }));

        logger.info("Container created with Markdown storage and Dolt index", {
          repoPath: config.repoPath,
          markdownRoot,
          doltHost: config.storage.doltHost,
          doltPort: config.storage.doltPort,
          doltDatabase: config.storage.doltDatabase,
        });
      }
    } catch (e) {
      logger.warn("Failed to initialize Dolt, falling back to in-memory storage", {
        error: e instanceof Error ? e.message : String(e),
        domain: "persistence",
      });
    }
  }

  // Fall through to in-memory if Dolt didn't initialize
  if (!searchRepo) {
    searchRepo = new InMemorySearchIndexRepository();
    orchestrationRepo = new InMemoryOrchestrationEventRepository();
    convoyRepo = new InMemoryConvoyRepository({ eventRepo: orchestrationRepo, logger });

    const degraded = config.storage.doltEnabled;
    status.register("storage", () => ({
      name: "storage",
      healthy: !degraded,
      detail: degraded
        ? `Markdown (${markdownRoot}) + in-memory index (degraded — Dolt unavailable)`
        : `Markdown (${markdownRoot})`,
    }));

    logger.info("Container created", {
      repoPath: config.repoPath,
      markdownRoot,
      verbosity: config.verbosity,
    });
  }

  let embeddingProvider: EmbeddingProvider;
  if (config.search.semanticEnabled && config.search.embeddingProvider === "ollama") {
    embeddingProvider = new OllamaEmbeddingProvider({
      ollamaUrl: config.search.ollamaUrl,
      embeddingModel: config.search.embeddingModel,
    });
    logger.info("Using Ollama embedding provider", {
      model: config.search.embeddingModel,
      url: config.search.ollamaUrl,
    });
  } else {
    embeddingProvider = new StubEmbeddingProvider();
  }

  const searchService = new SearchService({
    searchRepo: searchRepo!,
    knowledgeRepo: knowledgeRepo!,
    workRepo: workRepo!,
    embeddingProvider,
    config: config.search,
    logger,
    status,
    runtimeState,
    repoPath: config.repoPath,
  });
  // Wiki bookkeeper: maintains index.md + log.md (Karpathy second-brain style)
  const bookkeeper = new WikiBookkeeper(markdownRoot, logger);

  // Wire up services with repos — repos are guaranteed to be set by this point
  const knowledgeService = new KnowledgeService({
    knowledgeRepo: knowledgeRepo!,
    logger,
    searchSync: searchService,
    status,
    bookkeeper,
  });
  if (!snapshotRepo) {
    snapshotRepo = new InMemorySnapshotRepository();
  }
  if (!convoyRepo) {
    convoyRepo = new InMemoryConvoyRepository({ eventRepo: orchestrationRepo!, logger });
  }
  const snapshotService = new SnapshotService({
    repo: snapshotRepo,
    logger,
    maxAgeMinutes: config.context.snapshotMaxAgeMinutes,
  });
  const workService = new WorkService({
    workRepo: workRepo!,
    logger,
    searchSync: searchService,
    status,
    orchestrationRepo: orchestrationRepo!,
    bookkeeper,
    snapshotService,
    repoPath: config.repoPath,
  });
  // Cross-wire: both services need the opposite repo to keep index.md in sync.
  knowledgeService.setWorkRepo(workRepo!);
  workService.setKnowledgeRepo(knowledgeRepo!);
  const policyLoader = new PolicyLoader({
    knowledgeRepo: knowledgeRepo!,
    logger,
  });
  const agentDispatcher = new AgentDispatcher({
    workRepo: workRepo!,
    eventRepo: orchestrationRepo!,
    logger,
    policyLoader,
    dedupWindowMs: readDedupWindowFromEnv(),
    ...(readWorktreePathFromEnv() ? { worktreePath: readWorktreePathFromEnv()! } : {}),
  });
  const orchestrationService = new OrchestrationService({
    workRepo: workRepo!,
    orchestrationRepo: orchestrationRepo!,
    logger,
    autoAdvance: config.orchestration.autoAdvance,
    pollIntervalMs: config.orchestration.pollIntervalMs,
    maxConcurrentAgents: config.orchestration.maxConcurrentAgents,
    policyLoader,
    agentDispatcher,
    convoyRepo: convoyRepo!,
  });
  const structureService = new StructureService({
    knowledgeRepo: knowledgeRepo!,
    workRepo: workRepo!,
    repoPath: config.repoPath,
    logger,
  });
  const agentsService = new AgentService({
    workRepo: workRepo!,
    orchestrationRepo: orchestrationRepo!,
    logger,
  });
  const ingestService = new IngestService({
    knowledgeRepo: knowledgeRepo!,
    repoPath: config.repoPath,
    logger,
    searchSync: searchService,
    status,
  });
  // Wire up migration service if a v2 reader is provided
  const migrationService = options?.v2Reader
    ? new MigrationService({
        v2Reader: options.v2Reader,
        knowledgeRepo: knowledgeRepo!,
        workRepo: workRepo!,
        logger,
        status,
        runtimeState,
      })
    : undefined;
  if (options?.v2Reader) {
    stack.defer(() => options.v2Reader!.close());
  }

  // Register stat recording for observability
  const knowledgeCountResult = await knowledgeRepo!.findMany();
  const knowledgeArticleCount = knowledgeCountResult.ok ? knowledgeCountResult.value.length : 0;
  if (knowledgeCountResult.ok) {
    status.recordStat("knowledgeArticleCount", knowledgeArticleCount);
  }
  const workCountResult = await workRepo!.findMany();
  const workArticleCount = workCountResult.ok ? workCountResult.value.length : 0;
  if (workCountResult.ok) {
    status.recordStat("workArticleCount", workArticleCount);
  }
  const persistedRuntimeState = await runtimeState.read();
  if (persistedRuntimeState.lastMigrationAt) {
    status.recordStat("lastMigrationAt", persistedRuntimeState.lastMigrationAt);
  }
  // `lastReindexAt` reflects the user's last explicit reindex (CLI/MCP/dashboard).
  // Bootstrap reindex below runs with persistState:false and never overwrites it,
  // so we surface the persisted value here regardless of whether bootstrap fires.
  if (persistedRuntimeState.lastReindexAt) {
    status.recordStat("lastReindexAt", persistedRuntimeState.lastReindexAt);
  }

  // Search repositories can be ephemeral. Probe the live index on boot and
  // rebuild it when source articles exist but the queryable index is empty or stale.
  const sourceArticleCount = knowledgeArticleCount + workArticleCount;
  const canaryHealthy = await searchService.runCanary();
  const shouldBootstrapSearchIndex = sourceArticleCount > 0 && (searchRepo!.size === 0 || !canaryHealthy);

  if (shouldBootstrapSearchIndex) {
    logger.info("Bootstrapping search index from Markdown source articles", {
      sourceArticleCount,
      existingIndexSize: searchRepo!.size,
      canaryHealthy,
    });

    // Bootstrap reindex re-hydrates the in-memory search index on container
    // boot. It is NOT a user-initiated reindex, so we don't bump
    // `lastReindexAt` or write runtime-state — that would mutate
    // .monsthera/cache/runtime-state.json on every read-only `monsthera
    // status` call.
    const bootstrapResult = await searchService.fullReindex({ persistState: false });
    if (!bootstrapResult.ok) {
      logger.warn("Failed to bootstrap search index on startup; exposing live index state instead", {
        error: bootstrapResult.error.message,
        sourceArticleCount,
        existingIndexSize: searchRepo!.size,
      });
      status.recordStat("searchIndexSize", searchRepo!.size);
      status.recordStat("embeddingCount", searchRepo!.embeddingCount);
      status.recordStat("semanticSearchEnabled", config.search.semanticEnabled && searchRepo!.embeddingCount > 0);
    }
  } else {
    status.recordStat("searchIndexSize", searchRepo!.size);
    status.recordStat("embeddingCount", searchRepo!.embeddingCount);
    status.recordStat("semanticSearchEnabled", config.search.semanticEnabled && searchRepo!.embeddingCount > 0);
  }

  status.register("knowledge", () => ({
    name: "knowledge",
    healthy: true,
    detail: "Knowledge service",
  }));
  status.register("work", () => ({
    name: "work",
    healthy: true,
    detail: "Work service",
  }));
  status.register("search", () => {
    const health = searchService.getHealthStatus();
    return { name: "search", healthy: health.healthy, detail: health.detail };
  });
  status.register("structure", () => ({
    name: "structure",
    healthy: true,
    detail: "Structure service",
  }));
  status.register("agents", () => ({
    name: "agents",
    healthy: true,
    detail: "Agent directory service",
  }));
  status.register("ingest", () => ({
    name: "ingest",
    healthy: true,
    detail: "Local source import service",
  }));

  // Start auto-advance loop if configured
  if (config.orchestration.autoAdvance) {
    orchestrationService.start();
    stack.defer(() => { orchestrationService.stop(); });
  }

  // Resync monitor (ADR-009): observes agent_started events, ticks at the
  // configured cadence, and emits context_drift_detected /
  // agent_needs_resync as the snapshot ages. Hooked into the events_emit
  // code paths (CLI + MCP) downstream so external lifecycle writes
  // notify the monitor synchronously.
  const resyncMonitor = new ResyncMonitor({
    eventRepo: orchestrationRepo!,
    snapshotService,
    workRepo: workRepo!,
    logger,
    intervalMs: readResyncIntervalFromEnv(),
    ...(readWorktreePathFromEnv() ? { worktreePath: readWorktreePathFromEnv()! } : {}),
  });
  await resyncMonitor.start();
  stack.defer(() => { resyncMonitor.stop(); });

  return {
    config,
    logger,
    status,
    knowledgeRepo: knowledgeRepo!,
    knowledgeService,
    workRepo: workRepo!,
    workService,
    searchRepo: searchRepo!,
    searchService,
    orchestrationRepo: orchestrationRepo!,
    convoyRepo: convoyRepo!,
    orchestrationService,
    agentDispatcher,
    resyncMonitor,
    structureService,
    agentsService,
    ingestService,
    migrationService,
    bookkeeper,
    snapshotRepo,
    snapshotService,
    async dispose() {
      logger.info("Shutting down container");
      await stack.dispose();
    },
  };
}

/**
 * Create a container for testing with optional overrides.
 */
export async function createTestContainer(
  overrides?: Partial<MonstheraContainer>,
): Promise<MonstheraContainer> {
  const { defaultConfig } = await import("./config.js");
  const repoPath = path.join("/tmp", `monsthera-test-${randomUUID()}`);
  const config = defaultConfig(repoPath);
  const container = await createContainer(config);
  const dispose = async () => {
    await container.dispose();
    await fs.rm(repoPath, { recursive: true, force: true });
  };
  return { ...container, ...overrides, dispose };
}
