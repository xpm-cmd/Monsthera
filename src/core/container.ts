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
import { StubReranker, CrossEncoderReranker } from "../search/reranker.js";
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
import { CodeIntelligenceService } from "../code-intelligence/service.js";
import { CodeInventoryService } from "../code-intelligence/inventory/service.js";
import type { DoltMirrorClient } from "../code-intelligence/inventory/persistence.js";
import type { SessionRepository } from "../sessions/repository.js";
import { FileSystemSessionRepository } from "../sessions/file-repository.js";
import { SessionService } from "../sessions/service.js";
import { DefaultFactsExtractor } from "../sessions/facts-extractor.js";
import {
  resolveWorkspaceLocation,
  buildFallbackMarkdownRoot,
} from "../sessions/workspace-resolver.js";
import { realCommandRunner } from "../ops/command-runner.js";
import type { LLMSummarizer } from "../sessions/llm-summarizer.js";
import { OllamaSummarizer } from "../sessions/llm-summarizer.js";
import { OllamaTextGenerator, OpenAITextGenerator, StubTextGenerator } from "./text-generator.js";
import type { TextGenerator } from "./text-generator.js";

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
  /**
   * The wired embedding provider (Ollama or the stub). Exposed so diagnostics
   * — `monsthera eval` engine detection and `monsthera doctor` — can probe the
   * REAL provider's `healthCheck()` instead of reconstructing one from config.
   * `SearchService` holds the same instance internally for the hot path.
   */
  readonly embeddingProvider: EmbeddingProvider;
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
  readonly codeIntelligenceService: CodeIntelligenceService;
  readonly codeInventoryService: CodeInventoryService;
  readonly sessionRepo: SessionRepository;
  readonly sessionService: SessionService;
  /** General-purpose LLM text generator (think synthesis + work→knowledge distillation). Stub when `llm.enabled` is false. */
  readonly textGenerator: TextGenerator;
}

/**
 * Create the Monsthera runtime container.
 * Wires up all dependencies based on config.
 */
/**
 * Container creation can fall back to in-memory storage when Dolt is
 * configured but unreachable. That fallback is **opt-in** because a user
 * who configured Dolt almost certainly wants their work to persist —
 * silently degrading to in-memory means a session's worth of mutations
 * disappear at the next restart.
 *
 * Opt-in mechanisms:
 *   - `options.allowDegraded: true` (programmatic; tests, embeddings)
 *   - `MONSTHERA_ALLOW_DEGRADED=1` env var (recommended for emergency
 *     read-only sessions when Dolt is down)
 */
export class DoltUnavailableError extends Error {
  readonly code = "DOLT_UNAVAILABLE";
  readonly cause?: string;
  constructor(cause?: string) {
    super(
      `Dolt is configured (storage.doltEnabled=true) but unreachable. ` +
        `Refusing to start in degraded in-memory mode because mutations would ` +
        `not persist across restart. ` +
        `Resolve by starting Dolt (\`monsthera self restart dolt\`), running ` +
        `\`monsthera self doctor --fix\`, or — for an emergency read-only ` +
        `session — re-running with \`MONSTHERA_ALLOW_DEGRADED=1\`. ` +
        (cause ? `Underlying cause: ${cause}` : ""),
    );
    this.name = "DoltUnavailableError";
    this.cause = cause;
  }
}

function shouldAllowDegraded(options?: { allowDegraded?: boolean }): boolean {
  if (options?.allowDegraded === true) return true;
  const env = process.env["MONSTHERA_ALLOW_DEGRADED"];
  return env === "1" || env === "true";
}

export async function createContainer(
  config: MonstheraConfig,
  options?: { v2Reader?: V2SourceReader; allowDegraded?: boolean },
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

  // Worktree fallback: when running inside a git worktree, also read from
  // the main repo's knowledge dir so sessions and handoff articles created
  // in other worktrees (or in main) remain visible. Writes still go to
  // primary only. Resolution is best-effort — a non-git workspace or a
  // missing git binary just yields `null` and the system stays
  // worktree-isolated.
  const workspaceLocation = await resolveWorkspaceLocation(config.repoPath, realCommandRunner);
  const fallbackMarkdownRoot = workspaceLocation.ok
    ? buildFallbackMarkdownRoot(workspaceLocation.value, config.storage.markdownRoot)
    : null;

  knowledgeRepo = new FileSystemKnowledgeArticleRepository(markdownRoot, fallbackMarkdownRoot);
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
        await closePool(doltPool);
        doltPool = undefined;
        if (!shouldAllowDegraded(options)) {
          throw new DoltUnavailableError(schemaResult.error.message);
        }
        logger.warn("Dolt schema initialization failed, falling back to in-memory storage (allowDegraded=true)", {
          error: schemaResult.error.message,
          domain: "persistence",
        });
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
      if (e instanceof DoltUnavailableError) {
        // Already wrapped — let it propagate so the CLI/MCP entry point
        // can surface it cleanly without a stack trace.
        throw e;
      }
      if (!shouldAllowDegraded(options)) {
        throw new DoltUnavailableError(e instanceof Error ? e.message : String(e));
      }
      logger.warn("Failed to initialize Dolt, falling back to in-memory storage (allowDegraded=true)", {
        error: e instanceof Error ? e.message : String(e),
        domain: "persistence",
      });
    }
  }

  // Fall through to in-memory if Dolt didn't initialize
  if (!searchRepo) {
    searchRepo = new InMemorySearchIndexRepository({
      bm25K1: config.search.bm25K1,
      titleBoost: config.search.titleBoost,
    });
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

  // Wire the M3 lightweight code inventory (ADR-017) before SearchService so
  // the M3 phase-4 breadcrumb in `build_context_pack(mode="code")` can reach
  // the inventory query. The service is independent of `CodeIntelligenceService`
  // and owns the JSON cache at `.monsthera/cache/code-index.json`, optionally
  // mirroring into Dolt. `doltClient` is `null` when Dolt is disabled or
  // unreachable; the mirror then short-circuits and the JSON cache remains
  // canonical (ADR-014 portable-workspace rule).
  const codeInventoryDoltClient: DoltMirrorClient | null = doltPool
    ? {
        async execute(sql, params) {
          await doltPool.execute(sql, (params ?? []) as (string | number | null)[]);
        },
      }
    : null;
  const codeInventoryService = new CodeInventoryService({
    repoPath: config.repoPath,
    logger,
    doltClient: codeInventoryDoltClient,
  });

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
    inventoryService: codeInventoryService,
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
    knowledgeService,
    snapshotService,
    repoPath: config.repoPath,
    convoyRepo: convoyRepo!,
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

  const codeIntelligenceService = new CodeIntelligenceService({
    knowledgeRepo: knowledgeRepo!,
    workRepo: workRepo!,
    structureService,
    repoPath: config.repoPath,
    logger,
    eventRepo: orchestrationRepo!,
    inventoryService: codeInventoryService,
  });
  // Session subsystem: persists per-agent session lifecycle records, the
  // Stage A facts artifact, and (when LLM is enabled and Ollama is reachable)
  // the Stage B+C+D handoff article. The summarizer is constructed eagerly
  // but its `healthCheck()` runs at close-time — Ollama being down does not
  // block container startup; the service falls back to T1-only handoffs.
  const sessionRepo: SessionRepository = new FileSystemSessionRepository(
    markdownRoot,
    fallbackMarkdownRoot,
  );
  const sessionSummarizer: LLMSummarizer | null = config.sessions.llmEnabled
    ? new OllamaSummarizer({
        ollamaUrl: config.search.ollamaUrl,
        model: config.sessions.llmModel,
        temperature: config.sessions.llmTemperature,
        timeoutMs: config.sessions.llmTimeoutMs,
      })
    : null;

  // General-purpose text generator (PR-3): provider-pluggable; consumed by
  // think synthesis (PR-5) and work→knowledge distillation (PR-6). The API key
  // is read from env only, never from the validated config object.
  let textGenerator: TextGenerator;
  if (!config.llm.enabled) {
    textGenerator = new StubTextGenerator();
  } else if (config.llm.provider === "openai") {
    const apiKey = process.env["MONSTHERA_LLM_API_KEY"] ?? process.env["OPENAI_API_KEY"] ?? "";
    textGenerator = new OpenAITextGenerator({
      baseUrl: config.llm.baseUrl,
      apiKey,
      model: config.llm.model,
      temperature: config.llm.temperature,
      timeoutMs: config.llm.timeoutMs,
    });
  } else {
    textGenerator = new OllamaTextGenerator({
      ollamaUrl: config.search.ollamaUrl,
      model: config.llm.model,
      temperature: config.llm.temperature,
      timeoutMs: config.llm.timeoutMs,
    });
  }
  // PR-5: wire the generator into search (built after SearchService; mirrors setKnowledgeRepo).
  searchService.setTextGenerator(textGenerator);

  // PR-11 — reranker stage. Cross-encoder over the text generator when enabled,
  // otherwise a no-op stub. The stage itself is gated again by `rerankEnabled`
  // inside SearchService, so a stub here is harmless.
  searchService.setReranker(
    config.search.rerankEnabled ? new CrossEncoderReranker(textGenerator) : new StubReranker(),
  );
  const factsExtractor = new DefaultFactsExtractor({
    eventRepo: orchestrationRepo!,
    workRepo: workRepo!,
    knowledgeRepo: knowledgeRepo!,
    runner: realCommandRunner,
  });
  const sessionService = new SessionService(sessionRepo, factsExtractor, {
    summarizer: sessionSummarizer,
    knowledgeService,
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

  // ADR-017 §D9: lazy provider — `monsthera status` surfaces a compact
  // `codeInventory` block, computed at read time so it stays fresh after
  // reindex/build without us having to wire status updates from every code
  // path. `service.getStatus()` never triggers a build (D8): when the cache
  // file does not exist it resolves to `{ built: false, ... }` and returns
  // a snapshot derived from the in-memory state otherwise.
  status.registerStatProvider("codeInventory", async () => {
    const result = await codeInventoryService.getStatus();
    if (!result.ok) {
      logger.debug("codeInventory status provider failed", { error: result.error.message });
      return undefined;
    }
    return result.value;
  });

  // Search repositories can be ephemeral. Probe the live index on boot and
  // rebuild it when source articles exist but the queryable index is empty or stale.
  const sourceArticleCount = knowledgeArticleCount + workArticleCount;
  const canaryHealthy = await searchService.runCanary();
  const shouldBootstrapSearchIndex = sourceArticleCount > 0 && (searchRepo!.size === 0 || !canaryHealthy);

  // `semanticSearchEnabled` below is deliberately config+index only
  // (`semanticEnabled && embeddingCount > 0`) — "configured and has vectors",
  // NOT "the embedding provider is live right now". A liveness probe would mean
  // an HTTP `healthCheck()` to Ollama on every `createContainer`, i.e. on every
  // read-only `monsthera status` call, adding network latency and an offline
  // failure mode to a hot path that must stay fast. Operational liveness is
  // surfaced by `monsthera doctor` and `monsthera eval` (engine=…) instead,
  // where a live call's latency is acceptable. See P1 eval-honesty work.
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
  status.register("code-intelligence", () => ({
    name: "code-intelligence",
    healthy: true,
    detail: "Code-ref intelligence service",
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
    embeddingProvider,
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
    codeIntelligenceService,
    codeInventoryService,
    sessionRepo,
    sessionService,
    textGenerator,
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
