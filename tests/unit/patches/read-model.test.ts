import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import {
  buildPatchDetailPayload,
  buildPatchListPayload,
  buildPatchSummaryPayload,
} from "../../../src/patches/read-model.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), ticket_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog', severity TEXT NOT NULL DEFAULT 'medium', priority INTEGER NOT NULL DEFAULT 5, tags_json TEXT, affected_paths_json TEXT, acceptance_criteria TEXT, creator_agent_id TEXT NOT NULL, creator_session_id TEXT NOT NULL, assignee_agent_id TEXT, resolved_by_agent_id TEXT, commit_sha TEXT NOT NULL, required_roles_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE patches (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), proposal_id TEXT NOT NULL UNIQUE, base_commit TEXT NOT NULL, bundle_id TEXT, state TEXT NOT NULL, diff TEXT NOT NULL, message TEXT NOT NULL, touched_paths_json TEXT, dry_run_result_json TEXT, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, committed_sha TEXT, ticket_id INTEGER REFERENCES tickets(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("patch read model", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let repoId: number;
  let otherRepoId: number;
  const now = "2026-03-12T03:20:00.000Z";

  beforeEach(() => {
    ({ db, sqlite } = createTestDb());
    repoId = queries.upsertRepo(db, "/repo", "repo").id;
    otherRepoId = queries.upsertRepo(db, "/other", "other").id;
  });

  afterEach(() => sqlite.close());

  it("builds repo-scoped patch lists with linked public ticket ids", () => {
    const ticket = queries.insertTicket(db, {
      repoId,
      ticketId: "TKT-local001",
      title: "Local ticket",
      description: "Desc",
      status: "backlog",
      severity: "medium",
      priority: 5,
      creatorAgentId: "agent-1",
      creatorSessionId: "session-1",
      commitSha: "abc1234",
      createdAt: now,
      updatedAt: now,
    });
    queries.insertPatch(db, {
      repoId,
      proposalId: "patch_local_1",
      baseCommit: "abc1234",
      state: "validated",
      diff: "---",
      message: "Local patch",
      agentId: "agent-1",
      sessionId: "session-1",
      ticketId: ticket.id,
      createdAt: now,
      updatedAt: now,
    });
    queries.insertPatch(db, {
      repoId: otherRepoId,
      proposalId: "patch_other_1",
      baseCommit: "def5678",
      state: "stale",
      diff: "---",
      message: "Foreign patch",
      agentId: "agent-2",
      sessionId: "session-2",
      createdAt: now,
      updatedAt: now,
    });

    const payload = buildPatchListPayload(db, repoId);

    expect(payload).toEqual({
      count: 1,
      patches: [{
        proposalId: "patch_local_1",
        state: "validated",
        persistedStale: false,
        message: "Local patch",
        baseCommit: "abc1234",
        agentId: "agent-1",
        createdAt: now,
        linkedTicketId: "TKT-local001",
        touchedPathCount: 0,
        validation: {
          feasible: null,
          policyViolationCount: 0,
          secretWarningCount: 0,
          reindexScope: null,
          policyViolations: [],
          secretWarnings: [],
        },
      }],
    });
  });

  it("builds patch detail payloads with touched paths and dry-run data", () => {
    queries.insertPatch(db, {
      repoId,
      proposalId: "patch_detail_1",
      baseCommit: "abc1234",
      bundleId: "bundle-1",
      state: "validated",
      diff: "---",
      message: "Detail patch",
      touchedPathsJson: JSON.stringify(["src/cli/tickets.ts", "src/index.ts"]),
      dryRunResultJson: JSON.stringify({ touchedPaths: ["src/cli/tickets.ts"], appliesCleanly: true }),
      agentId: "agent-1",
      sessionId: "session-1",
      committedSha: "ff00aa",
      createdAt: now,
      updatedAt: now,
    });

    const payload = buildPatchDetailPayload(db, repoId, "patch_detail_1");

    expect(payload).toMatchObject({
      proposalId: "patch_detail_1",
      state: "validated",
      persistedStale: false,
      bundleId: "bundle-1",
      touchedPaths: ["src/cli/tickets.ts", "src/index.ts"],
      dryRunResult: {
        touchedPaths: ["src/cli/tickets.ts"],
        appliesCleanly: true,
      },
      validation: {
        feasible: null,
        policyViolationCount: 0,
        secretWarningCount: 0,
        reindexScope: 2,
        policyViolations: [],
        secretWarnings: [],
      },
    });
  });

  it("builds patch summary payloads with state counts and recent items", () => {
    queries.insertPatch(db, {
      repoId,
      proposalId: "patch_sum_1",
      baseCommit: "abc1234",
      state: "validated",
      diff: "---",
      message: "Validated patch",
      agentId: "agent-1",
      sessionId: "session-1",
      createdAt: now,
      updatedAt: now,
    });
    queries.insertPatch(db, {
      repoId,
      proposalId: "patch_sum_2",
      baseCommit: "abc1234",
      state: "stale",
      diff: "---",
      message: "Stale patch",
      agentId: "agent-2",
      sessionId: "session-2",
      createdAt: "2026-03-12T03:21:00.000Z",
      updatedAt: "2026-03-12T03:21:00.000Z",
    });

    const payload = buildPatchSummaryPayload(db, repoId);

    expect(payload.totalCount).toBe(2);
    expect(payload.stateCounts).toMatchObject({
      validated: 1,
      stale: 1,
    });
    expect(payload.validationCounts).toMatchObject({
      feasible: 0,
      blocked: 0,
      unknown: 2,
      persistedStale: 1,
      withPolicyViolations: 0,
      withSecretWarnings: 0,
    });
    expect(payload.recent.map((entry) => entry.proposalId)).toEqual(["patch_sum_2", "patch_sum_1"]);
  });
});
