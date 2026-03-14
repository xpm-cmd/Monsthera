import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { validatePatch } from "../../../src/patches/validator.js";

vi.mock("../../../src/git/operations.js", () => ({
  getHead: vi.fn().mockResolvedValue("abc1234def5678"),
}));

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  for (const stmt of [
    `CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', provider TEXT, model TEXT, model_family TEXT, model_version TEXT, identity_source TEXT, role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL)`,
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT, worktree_path TEXT, worktree_branch TEXT)`,
    `CREATE TABLE protected_artifacts (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), path_pattern TEXT NOT NULL, reason TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(repo_id, path_pattern))`,
  ]) {
    sqlite.prepare(stmt).run();
  }
  sqlite.prepare("INSERT INTO repos (path, name, created_at) VALUES (?, ?, ?)").run("/repo", "test", new Date().toISOString());
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("validatePatch", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    sqlite = result.sqlite;
  });
  afterEach(() => sqlite.close());

  const diff = `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new`;

  it("validates a patch at current HEAD", async () => {
    const result = await validatePatch(db, "/repo", 1, {
      diff,
      message: "fix foo",
      baseCommit: "abc1234def5678",
    });

    expect(result.valid).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.proposalId).toMatch(/^patch-/);
    expect(result.dryRunResult.touchedPaths).toContain("src/foo.ts");
    expect(result.dryRunResult.feasible).toBe(true);
  });

  it("detects stale patches when HEAD != baseCommit", async () => {
    const result = await validatePatch(db, "/repo", 1, {
      diff,
      message: "fix foo",
      baseCommit: "differentcommit123",
    });

    expect(result.valid).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.dryRunResult.feasible).toBe(false);
  });

  it("detects file claim conflicts", async () => {
    // Set up an agent with claimed files
    sqlite.prepare(
      `INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("agent-1", "Dev", "test", "developer", "A", new Date().toISOString());
    sqlite.prepare(
      `INSERT INTO sessions (id, agent_id, state, connected_at, last_activity, claimed_files_json) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("session-1", "agent-1", "active", new Date().toISOString(), new Date().toISOString(), JSON.stringify(["src/foo.ts"]));

    const result = await validatePatch(db, "/repo", 1, {
      diff,
      message: "fix foo",
      baseCommit: "abc1234def5678",
    });

    expect(result.dryRunResult.policyViolations).toHaveLength(1);
    expect(result.dryRunResult.policyViolations[0]).toContain("src/foo.ts");
    expect(result.dryRunResult.feasible).toBe(false);
  });

  it("ignores malformed stored claim JSON when checking conflicts", async () => {
    sqlite.prepare(
      `INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("agent-1", "Dev", "test", "developer", "A", new Date().toISOString());
    sqlite.prepare(
      `INSERT INTO sessions (id, agent_id, state, connected_at, last_activity, claimed_files_json) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("session-1", "agent-1", "active", new Date().toISOString(), new Date().toISOString(), "{bad json");

    const result = await validatePatch(db, "/repo", 1, {
      diff,
      message: "fix foo",
      baseCommit: "abc1234def5678",
    });

    expect(result.dryRunResult.policyViolations).toEqual([]);
    expect(result.dryRunResult.feasible).toBe(true);
  });

  it("detects secrets in diff content", async () => {
    const secretDiff = `--- a/config.ts\n+++ b/config.ts\n@@ -1 +1 @@\n-old\n+const key = "sk_live_abcdefghijklmnopqrstuvwx"`;

    const result = await validatePatch(db, "/repo", 1, {
      diff: secretDiff,
      message: "add config",
      baseCommit: "abc1234def5678",
    });

    expect(result.dryRunResult.secretWarnings.length).toBeGreaterThan(0);
  });

  it("detects custom secrets in diff content", async () => {
    const secretDiff = `--- a/config.ts\n+++ b/config.ts\n@@ -1 +1 @@\n-old\n+const token = "corp_ABC123XYZ456"`;

    const result = await validatePatch(db, "/repo", 1, {
      diff: secretDiff,
      message: "add config",
      baseCommit: "abc1234def5678",
      secretPatterns: [{ name: "corp_token", pattern: /corp_[A-Z0-9]{12}/g }],
    });

    expect(result.dryRunResult.secretWarnings).toContain("corp_token detected at diff line 5");
  });

  it("extracts multiple touched paths", async () => {
    const multiDiff = [
      "--- a/src/a.ts", "+++ b/src/a.ts",
      "--- a/src/b.ts", "+++ b/src/b.ts",
      "--- a/lib/c.js", "+++ b/lib/c.js",
    ].join("\n");

    const result = await validatePatch(db, "/repo", 1, {
      diff: multiDiff,
      message: "multi file",
      baseCommit: "abc1234def5678",
    });

    expect(result.dryRunResult.touchedPaths).toHaveLength(3);
    expect(result.dryRunResult.touchedPaths).toContain("src/a.ts");
    expect(result.dryRunResult.touchedPaths).toContain("src/b.ts");
    expect(result.dryRunResult.touchedPaths).toContain("lib/c.js");
  });

  it("rejects patches touching exact protected artifact", async () => {
    sqlite.prepare(
      "INSERT INTO protected_artifacts (repo_id, path_pattern, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "src/foo.ts", "Critical file", "admin-1", new Date().toISOString());

    const result = await validatePatch(db, "/repo", 1, {
      diff,
      message: "fix foo",
      baseCommit: "abc1234def5678",
    });

    expect(result.dryRunResult.policyViolations).toHaveLength(1);
    expect(result.dryRunResult.policyViolations[0]).toContain("Protected artifact");
    expect(result.dryRunResult.policyViolations[0]).toContain("src/foo.ts");
    expect(result.dryRunResult.feasible).toBe(false);
  });

  it("rejects patches touching directory-protected artifacts", async () => {
    sqlite.prepare(
      "INSERT INTO protected_artifacts (repo_id, path_pattern, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "src/", "Entire src protected", "admin-1", new Date().toISOString());

    const result = await validatePatch(db, "/repo", 1, {
      diff,
      message: "fix foo",
      baseCommit: "abc1234def5678",
    });

    expect(result.dryRunResult.policyViolations).toHaveLength(1);
    expect(result.dryRunResult.policyViolations[0]).toContain("Protected artifact");
    expect(result.dryRunResult.feasible).toBe(false);
  });

  it("rejects patches touching glob-protected artifacts", async () => {
    sqlite.prepare(
      "INSERT INTO protected_artifacts (repo_id, path_pattern, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "src/db/*", "DB files protected", "admin-1", new Date().toISOString());

    const dbDiff = `--- a/src/db/schema.ts\n+++ b/src/db/schema.ts\n@@ -1 +1 @@\n-old\n+new`;

    const result = await validatePatch(db, "/repo", 1, {
      diff: dbDiff,
      message: "change schema",
      baseCommit: "abc1234def5678",
    });

    expect(result.dryRunResult.policyViolations).toHaveLength(1);
    expect(result.dryRunResult.policyViolations[0]).toContain("src/db/*");
    expect(result.dryRunResult.feasible).toBe(false);
  });

  it("allows patches not touching protected artifacts", async () => {
    sqlite.prepare(
      "INSERT INTO protected_artifacts (repo_id, path_pattern, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "src/db/*", "DB files protected", "admin-1", new Date().toISOString());

    const result = await validatePatch(db, "/repo", 1, {
      diff,
      message: "fix foo",
      baseCommit: "abc1234def5678",
    });

    expect(result.dryRunResult.policyViolations).toHaveLength(0);
    expect(result.dryRunResult.feasible).toBe(true);
  });
});
