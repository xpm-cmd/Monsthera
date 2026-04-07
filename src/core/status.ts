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
}

export interface StatusReporter {
  /** Register a subsystem health check */
  register(name: string, check: () => SubsystemStatus): void;

  /** Unregister a subsystem */
  unregister(name: string): void;

  /** Get current system status */
  getStatus(): SystemStatus;
}

export function createStatusReporter(version: string): StatusReporter {
  const startTime = Date.now();
  const checks = new Map<string, () => SubsystemStatus>();

  return {
    register(name, check) {
      checks.set(name, check);
    },

    unregister(name) {
      checks.delete(name);
    },

    getStatus(): SystemStatus {
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
    },
  };
}
