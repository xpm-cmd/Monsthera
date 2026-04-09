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
import { StubEmbeddingProvider, OllamaEmbeddingProvider } from "../search/embedding.js";
import type { EmbeddingProvider } from "../search/embedding.js";
import { SearchService } from "../search/service.js";
import { OrchestrationService } from "../orchestration/service.js";
import { MigrationService } from "../migration/service.js";
import type { V2SourceReader } from "../migration/types.js";
import { StructureService } from "../structure/service.js";
import { AgentService } from "../agents/service.js";
import { IngestService } from "../ingest/service.js";

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
  readonly orchestrationService: OrchestrationService;
  readonly structureService: StructureService;
  readonly agentsService: AgentService;
  readonly ingestService: IngestService;
  readonly migrationService?: MigrationService;
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
        // Only search index and orchestration events (derived data) move to Dolt.
        searchRepo = new DoltSearchIndexRepository(doltPool);
        orchestrationRepo = new DoltOrchestrationRepository(doltPool);

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
  // Wire up services with repos — repos are guaranteed to be set by this point
  const knowledgeService = new KnowledgeService({
    knowledgeRepo: knowledgeRepo!,
    logger,
    searchSync: searchService,
    status,
  });
  const workService = new WorkService({
    workRepo: workRepo!,
    logger,
    searchSync: searchService,
    status,
    orchestrationRepo: orchestrationRepo!,
  });
  const orchestrationService = new OrchestrationService({
    workRepo: workRepo!,
    orchestrationRepo: orchestrationRepo!,
    logger,
    autoAdvance: config.orchestration.autoAdvance,
    pollIntervalMs: config.orchestration.pollIntervalMs,
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
  if (knowledgeCountResult.ok) {
    status.recordStat("knowledgeArticleCount", knowledgeCountResult.value.length);
  }
  const workCountResult = await workRepo!.findMany();
  if (workCountResult.ok) {
    status.recordStat("workArticleCount", workCountResult.value.length);
  }
  const persistedRuntimeState = await runtimeState.read();
  if (persistedRuntimeState.searchIndexSize !== undefined) {
    status.recordStat("searchIndexSize", persistedRuntimeState.searchIndexSize);
  }
  if (persistedRuntimeState.lastReindexAt) {
    status.recordStat("lastReindexAt", persistedRuntimeState.lastReindexAt);
  }
  if (persistedRuntimeState.lastMigrationAt) {
    status.recordStat("lastMigrationAt", persistedRuntimeState.lastMigrationAt);
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
  status.register("search", () => ({
    name: "search",
    healthy: true,
    detail: "Search service",
  }));
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
    orchestrationService,
    structureService,
    agentsService,
    ingestService,
    migrationService,
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
