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
  readonly orchestrationRepo: OrchestrationEventRepository;
}

/**
 * Create the Monsthera runtime container.
 * Wires up all dependencies based on config.
 */
export async function createContainer(config: MonstheraConfig): Promise<MonstheraContainer> {
  const stack = new DisposableStack();

  // Create logger based on verbosity
  const logLevel = config.verbosity === "quiet" ? "warn"
    : config.verbosity === "debug" ? "debug"
    : config.verbosity === "verbose" ? "debug"
    : "info";

  const logger = createLogger({ level: logLevel, domain: "monsthera" });

  // Create status reporter
  const status = createStatusReporter(VERSION);

  // Phase 3: Real in-memory knowledge + work repositories; other repos remain stubs
  const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const workRepo = new InMemoryWorkArticleRepository();
  const searchRepo = createInMemoryStub<SearchIndexRepository>("SearchIndexRepository");
  const orchestrationRepo = createInMemoryStub<OrchestrationEventRepository>("OrchestrationEventRepository");

  // Wire up KnowledgeService and WorkService with real repos
  const knowledgeService = new KnowledgeService({ knowledgeRepo, logger });
  const workService = new WorkService({ workRepo, logger });

  // Register subsystem health checks
  status.register("storage", () => ({
    name: "storage",
    healthy: true,
    detail: "In-memory (Phase 3)",
  }));

  logger.info("Container created", { repoPath: config.repoPath, verbosity: config.verbosity });

  return {
    config,
    logger,
    status,
    knowledgeRepo,
    knowledgeService,
    workRepo,
    workService,
    searchRepo,
    orchestrationRepo,
    async dispose() {
      logger.info("Shutting down container");
      await stack.dispose();
    },
  };
}

/**
 * Create a stub that throws "not implemented" for any method call.
 * Used in Phase 1 before real repository implementations exist.
 */
function createInMemoryStub<T extends object>(name: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (prop === "then") return undefined; // Don't trap Promise checks
      return () => {
        throw new Error(`${name}.${String(prop)}() is not implemented (Phase 1 stub)`);
      };
    },
  });
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
