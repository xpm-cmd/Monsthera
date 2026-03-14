import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import {
  getDashboardEventsAfter,
  getLatestDashboardEventId,
  getLatestTicketSyncCursor,
  recordDashboardEvent,
} from "../../../src/dashboard/events.js";

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

  it("detects external ticket mutations even without dashboard events", () => {
    tempDir = mkdtempSync(join(tmpdir(), "agora-dashboard-ticket-sync-"));
    const dbPath = join(tempDir, "agora.db");

    const sqliteA = new Database(dbPath);
    const sqliteB = new Database(dbPath);
    sqliteA.pragma("journal_mode = WAL");
    sqliteB.pragma("journal_mode = WAL");

    sqliteA.exec(`
      CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, required_roles_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE ticket_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, from_status TEXT, to_status TEXT NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, comment TEXT, timestamp TEXT NOT NULL);
      CREATE TABLE ticket_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE review_verdicts (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, specialization TEXT NOT NULL, verdict TEXT NOT NULL, reasoning TEXT, created_at TEXT NOT NULL, superseded_by INTEGER);
      CREATE TABLE ticket_dependencies (id INTEGER PRIMARY KEY AUTOINCREMENT, from_ticket_id INTEGER NOT NULL, to_ticket_id INTEGER NOT NULL, relation_type TEXT NOT NULL, created_by_agent_id TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE dashboard_events (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, event_type TEXT NOT NULL, data_json TEXT NOT NULL, timestamp TEXT NOT NULL);
    `);

    const dbA = drizzle(sqliteA, { schema });
    const dbB = drizzle(sqliteB, { schema });
    const repoId = queries.upsertRepo(dbA, "/test", "test").id;
    const now = "2026-03-12T00:00:00.000Z";

    const baseline = getLatestTicketSyncCursor(dbB, repoId);

    sqliteA.prepare(`
      INSERT INTO tickets (
        repo_id, ticket_id, title, description, status, severity, priority,
        creator_agent_id, creator_session_id, commit_sha, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(repoId, "TKT-1", "Sync me", "Desc", "ready_for_commit", "medium", 5, "agent-1", "session-1", "abc1234", now, now);

    const afterTicketInsert = getLatestTicketSyncCursor(dbB, repoId);
    expect(afterTicketInsert).not.toBe(baseline);

    sqliteA.prepare(`
      INSERT INTO ticket_comments (ticket_id, agent_id, session_id, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(1, "agent-2", "session-2", "External comment", "2026-03-12T00:00:01.000Z");

    const afterCommentInsert = getLatestTicketSyncCursor(dbB, repoId);
    expect(afterCommentInsert).not.toBe(afterTicketInsert);

    sqliteA.prepare(`
      INSERT INTO review_verdicts (ticket_id, agent_id, session_id, specialization, verdict, reasoning, created_at, superseded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, "agent-3", "session-3", "architect", "pass", "Architect review references src/dashboard/html.ts with concrete evidence.", "2026-03-12T00:00:02.000Z", null);

    const afterVerdictInsert = getLatestTicketSyncCursor(dbB, repoId);
    expect(afterVerdictInsert).not.toBe(afterCommentInsert);

    sqliteA.close();
    sqliteB.close();
  });
});
