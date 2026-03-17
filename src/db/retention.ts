import { lt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema.js";
import * as tables from "./schema.js";

type DB = BetterSQLite3Database<typeof schema>;

export interface RetentionResult {
  eventLogsPruned: number;
  dashboardEventsPruned: number;
  debugPayloadsPruned: number;
}

/**
 * Prune old rows from append-only tables that grow without bound.
 * Safe to call on every startup or periodically.
 */
export function pruneOldEvents(db: DB, maxAgeDays = 30): RetentionResult {
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();

  const eventLogsPruned = db.delete(tables.eventLogs)
    .where(lt(tables.eventLogs.timestamp, cutoff))
    .run().changes;

  const dashboardEventsPruned = db.delete(tables.dashboardEvents)
    .where(lt(tables.dashboardEvents.timestamp, cutoff))
    .run().changes;

  const debugPayloadsPruned = db.delete(tables.debugPayloads)
    .where(lt(tables.debugPayloads.expiresAt, cutoff))
    .run().changes;

  return { eventLogsPruned, dashboardEventsPruned, debugPayloadsPruned };
}
