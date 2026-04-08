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
import { DisposableStack } from "./lifecycle.js";
import { InMemoryKnowledgeArticleRepository } from "../knowledge/in-memory-repository.js";
import { KnowledgeService } from "../knowledge/service.js";
import { InMemoryWorkArticleRepository } from "../work/in-memory-repository.js";
import { WorkService } from "../work/service.js";
import { InMemorySearchIndexRepository } from "../search/in-memory-repository.js";
import { InMemoryOrchestrationEventRepository } from "../orchestration/in-memory-repository.js";
import { StubEmbeddingProvider } from "../search/embedding.js";
import { SearchService } from "../search/service.js";
import { OrchestrationService } from "../orchestration/service.js";
import { MigrationService } from "../migration/service.js";
import type { V2SourceReader } from "../migration/types.js";

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

  let knowledgeRepo: KnowledgeArticleRepository | undefined;
  let workRepo: WorkArticleRepository | undefined;
  let searchRepo: SearchIndexRepository | undefined;
  let orchestrationRepo: OrchestrationEventRepository | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doltPool: any;

  if (config.storage.doltEnabled) {
    try {
      const {
        createDoltPool,
        closePool,
        initializeSchema,
        DoltKnowledgeArticleRepository,
        DoltWorkRepository,
        DoltSearchIndexRepository,
        DoltOrchestrationRepository,
      } = await import("../persistence/index.js");

      doltPool = createDoltPool({
        host: config.storage.doltHost,
        port: config.storage.doltPort,
        database: config.storage.doltDatabase,
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
        knowledgeRepo = new DoltKnowledgeArticleRepository(doltPool);
        workRepo = new DoltWorkRepository(doltPool);
        searchRepo = new DoltSearchIndexRepository(doltPool);
        orchestrationRepo = new DoltOrchestrationRepository(doltPool);

        stack.defer(() => closePool(doltPool));

        status.register("storage", () => ({
          name: "storage",
          healthy: true,
          detail: `Dolt (${config.storage.doltHost}:${config.storage.doltPort}/${config.storage.doltDatabase})`,
        }));

        logger.info("Container created with Dolt persistence", {
          repoPath: config.repoPath,
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
  if (!knowledgeRepo) {
    knowledgeRepo = new InMemoryKnowledgeArticleRepository();
    workRepo = new InMemoryWorkArticleRepository();
    searchRepo = new InMemorySearchIndexRepository();
    orchestrationRepo = new InMemoryOrchestrationEventRepository();

    const degraded = config.storage.doltEnabled;
    status.register("storage", () => ({
      name: "storage",
      healthy: !degraded,
      detail: degraded ? "In-memory (degraded — Dolt unavailable)" : "In-memory",
    }));

    logger.info("Container created", { repoPath: config.repoPath, verbosity: config.verbosity });
  }

  const embeddingProvider = new StubEmbeddingProvider();

  // Wire up services with repos — repos are guaranteed to be set by this point
  const knowledgeService = new KnowledgeService({ knowledgeRepo: knowledgeRepo!, logger });
  const workService = new WorkService({ workRepo: workRepo!, logger });
  const searchService = new SearchService({
    searchRepo: searchRepo!,
    knowledgeRepo: knowledgeRepo!,
    workRepo: workRepo!,
    embeddingProvider,
    config: config.search,
    logger,
  });
  const orchestrationService = new OrchestrationService({
    workRepo: workRepo!,
    orchestrationRepo: orchestrationRepo!,
    logger,
    autoAdvance: config.orchestration.autoAdvance,
    pollIntervalMs: config.orchestration.pollIntervalMs,
  });

  // Wire up migration service if a v2 reader is provided
  const migrationService = options?.v2Reader
    ? new MigrationService({ v2Reader: options.v2Reader, workRepo: workRepo!, logger })
    : undefined;

  // Register stat recording for observability
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
  const config = defaultConfig("/tmp/monsthera-test");
  const container = await createContainer(config);
  return { ...container, ...overrides };
}
