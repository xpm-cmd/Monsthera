import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";

type DB = BetterSQLite3Database<typeof schema>;

export interface DashboardEvent {
  type:
    | "agent_registered"
    | "session_changed"
    | "patch_proposed"
    | "note_added"
    | "event_logged"
    | "index_updated"
    | "knowledge_stored"
    | "ticket_created"
    | "ticket_assigned"
    | "ticket_status_changed"
    | "ticket_commented"
    | "ticket_linked";
  data: Record<string, unknown>;
}

export function recordDashboardEvent(
  db: DB,
  repoId: number,
  event: DashboardEvent,
): typeof schema.dashboardEvents.$inferSelect {
  return queries.insertDashboardEvent(db, {
    repoId,
    eventType: event.type,
    dataJson: JSON.stringify(event.data),
    timestamp: new Date().toISOString(),
  });
}

export function getDashboardEventsAfter(
  db: DB,
  repoId: number,
  afterId: number,
  limit = 100,
): Array<DashboardEvent & { id: number; timestamp: string }> {
  return queries.getDashboardEventsByRepo(db, repoId, { afterId, limit }).map((event) => ({
    id: event.id,
    type: event.eventType as DashboardEvent["type"],
    data: JSON.parse(event.dataJson) as Record<string, unknown>,
    timestamp: event.timestamp,
  }));
}

export function getLatestDashboardEventId(db: DB, repoId: number): number {
  return queries.getLatestDashboardEventId(db, repoId);
}
