import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import {
  buildKnowledgeDetailPayload,
  buildKnowledgeListPayload,
  buildKnowledgeSummaryPayload,
} from "../../../src/knowledge/read-model.js";

function createKnowledgeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      scope TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      tags_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      agent_id TEXT,
      session_id TEXT,
      embedding BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("knowledge read model", () => {
  let repoSqlite: InstanceType<typeof Database>;
  let globalSqlite: InstanceType<typeof Database>;
  let repoDb: ReturnType<typeof createKnowledgeDb>["db"];
  let globalDb: ReturnType<typeof createKnowledgeDb>["db"];
  const now = "2026-03-12T03:30:00.000Z";

  beforeEach(() => {
    ({ db: repoDb, sqlite: repoSqlite } = createKnowledgeDb());
    ({ db: globalDb, sqlite: globalSqlite } = createKnowledgeDb());
  });

  afterEach(() => {
    repoSqlite.close();
    globalSqlite.close();
  });

  it("builds combined knowledge lists across repo and global scopes", () => {
    queries.upsertKnowledge(repoDb, {
      key: "decision:repo1",
      type: "decision",
      scope: "repo",
      title: "Repo decision",
      content: "Use local CLI wrappers.",
      tagsJson: JSON.stringify(["cli", "repo"]),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    queries.upsertKnowledge(globalDb, {
      key: "pattern:global1",
      type: "pattern",
      scope: "global",
      title: "Global pattern",
      content: "Prefer structured JSON output.",
      tagsJson: JSON.stringify(["json"]),
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const payload = buildKnowledgeListPayload(repoDb, globalDb, { scope: "all" });

    expect(payload.count).toBe(2);
    expect(payload.entries.map((entry) => `${entry.scope}:${entry.key}`)).toEqual([
      "repo:decision:repo1",
      "global:pattern:global1",
    ]);
  });

  it("builds knowledge detail payloads and respects scope selection", () => {
    queries.upsertKnowledge(repoDb, {
      key: "decision:shared",
      type: "decision",
      scope: "repo",
      title: "Repo variant",
      content: "Repo content",
      tagsJson: JSON.stringify(["repo"]),
      status: "active",
      agentId: "agent-repo",
      sessionId: "session-repo",
      createdAt: now,
      updatedAt: now,
    });
    queries.upsertKnowledge(globalDb, {
      key: "decision:shared",
      type: "decision",
      scope: "global",
      title: "Global variant",
      content: "Global content",
      tagsJson: JSON.stringify(["global"]),
      status: "active",
      agentId: "agent-global",
      sessionId: "session-global",
      createdAt: now,
      updatedAt: now,
    });

    expect(buildKnowledgeDetailPayload(repoDb, globalDb, "decision:shared", "repo")).toMatchObject({
      scope: "repo",
      title: "Repo variant",
      tags: ["repo"],
    });
    expect(buildKnowledgeDetailPayload(repoDb, globalDb, "decision:shared", "global")).toMatchObject({
      scope: "global",
      title: "Global variant",
      tags: ["global"],
    });
  });

  it("builds knowledge summary payloads with scope, type, and status counts", () => {
    queries.upsertKnowledge(repoDb, {
      key: "decision:repo1",
      type: "decision",
      scope: "repo",
      title: "Repo decision",
      content: "Repo content",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    queries.upsertKnowledge(repoDb, {
      key: "plan:repo2",
      type: "plan",
      scope: "repo",
      title: "Archived plan",
      content: "Old content",
      status: "archived",
      createdAt: now,
      updatedAt: now,
    });
    queries.upsertKnowledge(globalDb, {
      key: "pattern:global1",
      type: "pattern",
      scope: "global",
      title: "Global pattern",
      content: "Global content",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const payload = buildKnowledgeSummaryPayload(repoDb, globalDb, { scope: "all", status: "active" });

    expect(payload.totalCount).toBe(2);
    expect(payload.scopeCounts).toMatchObject({
      repo: 1,
      global: 1,
    });
    expect(payload.typeCounts).toMatchObject({
      decision: 1,
      pattern: 1,
    });
    expect(payload.statusCounts).toMatchObject({
      active: 2,
    });
  });
});
