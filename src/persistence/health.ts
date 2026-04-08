import type { Pool } from "mysql2/promise";

/**
 * Health status of the Dolt database connection.
 */
export interface DoltHealthStatus {
  /** Whether the database is healthy and responding */
  healthy: boolean;
  /** Latency in milliseconds of the health check query */
  latencyMs: number;
  /** Dolt/MySQL version string */
  version?: string;
  /** Error message if unhealthy */
  error?: string;
}

/**
 * Check the health of the Dolt database connection.
 * Executes a simple query to verify connectivity and measures latency.
 */
export async function checkDoltHealth(pool: Pool): Promise<DoltHealthStatus> {
  const startTime = Date.now();

  try {
    const [rows] = await pool.execute("SELECT VERSION() as version");
    const latencyMs = Date.now() - startTime;

    let version: string | undefined;
    if (Array.isArray(rows) && rows.length > 0) {
      const row = rows[0] as Record<string, unknown>;
      version = typeof row.version === "string" ? row.version : undefined;
    }

    return {
      healthy: true,
      latencyMs,
      version,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      healthy: false,
      latencyMs,
      error: errorMessage,
    };
  }
}

/**
 * Continuously monitor database health at regular intervals.
 * Returns a cleanup function to stop monitoring.
 */
export function monitorDoltHealth(
  pool: Pool,
  options: {
    intervalMs?: number;
    onHealthChange?: (status: DoltHealthStatus) => void;
  } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 30000; // 30 seconds by default
  let isHealthy = true;
  let lastStatus: DoltHealthStatus | undefined;

  const interval = setInterval(async () => {
    const status = await checkDoltHealth(pool);

    // Notify on health state change
    if (status.healthy !== isHealthy || status.error !== lastStatus?.error) {
      isHealthy = status.healthy;
      lastStatus = status;
      options.onHealthChange?.(status);
    }
  }, intervalMs);

  return () => {
    clearInterval(interval);
  };
}
