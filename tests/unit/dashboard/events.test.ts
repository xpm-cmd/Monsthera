import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { getDashboardEventsAfter, getLatestDashboardEventId, recordDashboardEvent } from "../../../src/dashboard/events.js";

describe("dashboard events", () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("reads ticket events across separate SQLite connections", () => {
    tempDir = mkdtempSync(join(tmpdir(), "agora-dashboard-events-"));
    const dbPath = join(tempDir, "agora.db");

    const sqliteA = new Database(dbPath);
    const sqliteB = new Database(dbPath);
    sqliteA.pragma("journal_mode = WAL");
    sqliteB.pragma("journal_mode = WAL");

    sqliteA.exec(`
      CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE dashboard_events (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, event_type TEXT NOT NULL, data_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    `);

    const dbA = drizzle(sqliteA, { schema });
    const dbB = drizzle(sqliteB, { schema });
    const repoId = queries.upsertRepo(dbA, "/test", "test").id;

    const baseline = getLatestDashboardEventId(dbB, repoId);
    recordDashboardEvent(dbA, repoId, {
      type: "ticket_status_changed",
      data: { ticketId: "TKT-1", status: "in_review" },
    });

    const events = getDashboardEventsAfter(dbB, repoId, baseline);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("ticket_status_changed");
    expect(events[0]?.data).toMatchObject({ ticketId: "TKT-1", status: "in_review" });

    sqliteA.close();
    sqliteB.close();
  });
});
