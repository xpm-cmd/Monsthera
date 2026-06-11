import type { MonstheraConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { StatusReporter } from "../status.js";
import type { DisposableStack } from "../lifecycle.js";
import type { SearchIndexRepository } from "../../search/repository.js";
import type { OrchestrationEventRepository } from "../../orchestration/repository.js";
import type { ConvoyRepository } from "../../orchestration/convoy-repository.js";
import type { SnapshotRepository } from "../../context/snapshot-repository.js";

import { InMemorySearchIndexRepository } from "../../search/in-memory-repository.js";
import { InMemoryOrchestrationEventRepository } from "../../orchestration/in-memory-repository.js";
import { InMemoryConvoyRepository } from "../../orchestration/in-memory-convoy-repository.js";

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

/** Dependencies for {@link initializeStorageBackend}. */
export interface StorageBackendDeps {
  config: MonstheraConfig;
  logger: Logger;
  status: StatusReporter;
  /** Disposer stack owned by `createContainer`; pool close and health-monitor stop are deferred onto it. */
  stack: DisposableStack;
  markdownRoot: string;
  /** Evaluated lazily at the failure points — mirrors `shouldAllowDegraded(options)` in `createContainer`. */
  allowDegraded: () => boolean;
}

/** Repositories (and the raw Dolt pool handle) produced by storage-backend initialization. */
export interface StorageBackend {
  searchRepo: SearchIndexRepository | undefined;
  orchestrationRepo: OrchestrationEventRepository | undefined;
  convoyRepo: ConvoyRepository | undefined;
  snapshotRepo: SnapshotRepository | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doltPool: any;
}

/**
 * Initialize the storage backend: Dolt-backed repositories (search index,
 * orchestration events, snapshots, convoys) with schema init and background
 * health monitoring when `storage.doltEnabled`, otherwise — or on opt-in
 * degraded fallback — the in-memory implementations.
 */
export async function initializeStorageBackend(deps: StorageBackendDeps): Promise<StorageBackend> {
  const { config, logger, status, stack, markdownRoot, allowDegraded } = deps;

  let searchRepo: SearchIndexRepository | undefined;
  let orchestrationRepo: OrchestrationEventRepository | undefined;
  let convoyRepo: ConvoyRepository | undefined;
  let snapshotRepo: SnapshotRepository | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doltPool: any;

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
      } = await import("../../persistence/index.js");

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
        if (!allowDegraded()) {
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
      if (!allowDegraded()) {
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

  return { searchRepo, orchestrationRepo, convoyRepo, snapshotRepo, doltPool };
}
