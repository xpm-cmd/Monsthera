import type { Timestamp } from "./types.js";
import { timestamp } from "./types.js";

export interface SubsystemStatus {
  name: string;
  healthy: boolean;
  detail?: string;
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
  };
}

export interface StatusReporter {
  /** Register a subsystem health check */
  register(name: string, check: () => SubsystemStatus): void;

  /** Unregister a subsystem */
  unregister(name: string): void;

  /** Get current system status */
  getStatus(): SystemStatus;

  /** Record a stat value */
  recordStat(key: string, value: unknown): void;
}

export function createStatusReporter(version: string): StatusReporter {
  const startTime = Date.now();
  const checks = new Map<string, () => SubsystemStatus>();
  const stats = new Map<string, unknown>();

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

    getStatus(): SystemStatus {
      const subsystems: SubsystemStatus[] = [];
      for (const check of checks.values()) {
        subsystems.push(check());
      }

      const result: SystemStatus = {
        version,
        uptime: Date.now() - startTime,
        timestamp: timestamp(),
        subsystems,
      };
      if (stats.size > 0) {
        result.stats = Object.fromEntries(stats) as SystemStatus["stats"];
      }
      return result;
    },
  };
}
