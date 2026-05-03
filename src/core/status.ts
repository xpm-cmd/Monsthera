import type { Timestamp } from "./types.js";
import { timestamp } from "./types.js";

export interface SubsystemStatus {
  name: string;
  healthy: boolean;
  detail?: string;
}

/**
 * Status payload for the M3 lightweight code inventory (ADR-017 §D9).
 * Surfaced inside `SystemStatus.stats.codeInventory`. Read-only — callers
 * never trigger a build by inspecting status.
 */
export interface CodeInventoryStatusFragment {
  built: boolean;
  fileCount: number;
  symbolCount: number;
  languages: readonly string[];
  lastReindexAt?: string;
  staleFileCount?: number;
  degraded?: { reason: string };
}

export interface SystemStatus {
  version: string;
  uptime: number;
  timestamp: Timestamp;
  subsystems: SubsystemStatus[];
  stats?: {
    knowledgeArticleCount?: number;
    workArticleCount?: number;
    searchIndexSize?: number;
    lastReindexAt?: string;
    lastMigrationAt?: string;
    codeInventory?: CodeInventoryStatusFragment;
    [key: string]: unknown;
  };
}

/**
 * Provider for an async-loaded stat key. Resolves to the value to merge
 * into `stats[key]`, or `undefined` to omit the key entirely. The
 * provider is invoked at most once per `getStatusAsync()` call; results
 * are not cached across calls so the snapshot stays fresh.
 */
export type StatProvider = () => Promise<unknown>;

export interface StatusReporter {
  /** Register a subsystem health check */
  register(name: string, check: () => SubsystemStatus): void;

  /** Unregister a subsystem */
  unregister(name: string): void;

  /**
   * Synchronous status snapshot. Stats from `recordStat` are included
   * verbatim; async-loaded stats registered via `registerStatProvider`
   * are NOT included — use `getStatusAsync()` for the full picture.
   */
  getStatus(): SystemStatus;

  /**
   * Status snapshot with all registered async providers resolved and
   * merged into `stats`. A provider that throws or resolves to
   * `undefined` is silently skipped — status reads must not fail
   * because a single subsystem hiccupped.
   */
  getStatusAsync(): Promise<SystemStatus>;

  /** Record a stat value (snapshot — kept until next `recordStat` for the same key) */
  recordStat(key: string, value: unknown): void;

  /**
   * Register an async-loaded stat key. Re-registering the same key
   * replaces the previous provider. Use this for stats whose source
   * lives behind an async API (filesystem caches, lazy services).
   */
  registerStatProvider(key: string, provider: StatProvider): void;
}

export function createStatusReporter(version: string): StatusReporter {
  const startTime = Date.now();
  const checks = new Map<string, () => SubsystemStatus>();
  const stats = new Map<string, unknown>();
  const statProviders = new Map<string, StatProvider>();

  function buildBaseStatus(): SystemStatus {
    const subsystems: SubsystemStatus[] = [];
    for (const check of checks.values()) {
      subsystems.push(check());
    }
    return {
      version,
      uptime: Date.now() - startTime,
      timestamp: timestamp(),
      subsystems,
    };
  }

  function attachStats(base: SystemStatus, providerValues: Map<string, unknown>): SystemStatus {
    if (stats.size === 0 && providerValues.size === 0) return base;
    const merged: Record<string, unknown> = {};
    for (const [key, value] of stats) merged[key] = value;
    for (const [key, value] of providerValues) {
      if (value !== undefined) merged[key] = value;
    }
    if (Object.keys(merged).length === 0) return base;
    return { ...base, stats: merged as SystemStatus["stats"] };
  }

  return {
    register(name, check) {
      checks.set(name, check);
    },

    unregister(name) {
      checks.delete(name);
    },

    recordStat(key: string, value: unknown) {
      stats.set(key, value);
    },

    registerStatProvider(key: string, provider: StatProvider) {
      statProviders.set(key, provider);
    },

    getStatus(): SystemStatus {
      return attachStats(buildBaseStatus(), new Map());
    },

    async getStatusAsync(): Promise<SystemStatus> {
      const base = buildBaseStatus();
      if (statProviders.size === 0) return attachStats(base, new Map());

      const entries = [...statProviders.entries()];
      const settled = await Promise.allSettled(entries.map(([, provider]) => provider()));
      const resolved = new Map<string, unknown>();
      for (let i = 0; i < entries.length; i += 1) {
        const [key] = entries[i]!;
        const outcome = settled[i]!;
        if (outcome.status === "fulfilled" && outcome.value !== undefined) {
          resolved.set(key, outcome.value);
        }
      }
      return attachStats(base, resolved);
    },
  };
}
