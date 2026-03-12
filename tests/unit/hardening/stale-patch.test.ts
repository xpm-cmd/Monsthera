import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { validatePatch } from "../../../src/patches/validator.js";

// Mock HEAD to simulate different states
const mockGetHead = vi.fn();
vi.mock("../../../src/git/operations.js", () => ({
  getHead: (...args: unknown[]) => mockGetHead(...args),
}));

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  for (const stmt of [
    `CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'unknown', provider TEXT, model TEXT, model_family TEXT, model_version TEXT, identity_source TEXT, role_id TEXT NOT NULL DEFAULT 'observer', trust_tier TEXT NOT NULL DEFAULT 'B', registered_at TEXT NOT NULL)`,
    `CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), state TEXT NOT NULL DEFAULT 'active', connected_at TEXT NOT NULL, last_activity TEXT NOT NULL, claimed_files_json TEXT)`,
  ]) {
    sqlite.prepare(stmt).run();
  }
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("Class 7: Stale Patch Detection", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;
  const diff = `--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new`;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    sqlite = result.sqlite;
  });
  afterEach(() => sqlite.close());

  it("accepts patch when HEAD matches baseCommit", async () => {
    mockGetHead.mockResolvedValue("abcd1234");

    const result = await validatePatch(db, "/repo", 1, {
      diff, message: "fix", baseCommit: "abcd1234",
    });

    expect(result.valid).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.dryRunResult.feasible).toBe(true);
  });

  it("rejects patch when HEAD differs from baseCommit", async () => {
    mockGetHead.mockResolvedValue("new_head_after_commit");

    const result = await validatePatch(db, "/repo", 1, {
      diff, message: "fix", baseCommit: "old_head_before_commit",
    });

    expect(result.valid).toBe(false);
    expect(result.stale).toBe(true);
    expect(result.dryRunResult.feasible).toBe(false);
  });

  it("detects claim conflicts as warnings (not hard blocks)", async () => {
    mockGetHead.mockResolvedValue("abc123");

    sqlite.prepare(`INSERT INTO agents (id, name, type, role_id, trust_tier, registered_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("agent-other", "Other", "test", "developer", "A", new Date().toISOString());
    sqlite.prepare(`INSERT INTO sessions (id, agent_id, state, connected_at, last_activity, claimed_files_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run("s-other", "agent-other", "active", new Date().toISOString(), new Date().toISOString(), JSON.stringify(["src/foo.ts"]));

    const result = await validatePatch(db, "/repo", 1, {
      diff, message: "fix", baseCommit: "abc123",
    });

    // Patch is valid (HEAD matches) but has policy violations
    expect(result.valid).toBe(true);
    expect(result.stale).toBe(false);
    expect(result.dryRunResult.policyViolations.length).toBeGreaterThan(0);
    expect(result.dryRunResult.policyViolations[0]).toContain("src/foo.ts");
    expect(result.dryRunResult.feasible).toBe(false); // not feasible due to claim
  });

  it("second patch fails stale-rejection after first changes HEAD", async () => {
    // First patch: HEAD = abc123, baseCommit = abc123 → valid
    mockGetHead.mockResolvedValue("abc123");
    const first = await validatePatch(db, "/repo", 1, {
      diff, message: "first fix", baseCommit: "abc123",
    });
    expect(first.valid).toBe(true);

    // Simulate first patch being applied (HEAD moves)
    mockGetHead.mockResolvedValue("def456");

    // Second patch with old baseCommit → stale
    const second = await validatePatch(db, "/repo", 1, {
      diff, message: "second fix", baseCommit: "abc123",
    });
    expect(second.valid).toBe(false);
    expect(second.stale).toBe(true);
  });

  it("warns about secrets in diff without blocking", async () => {
    mockGetHead.mockResolvedValue("abc123");

    const secretDiff = `--- a/config.ts\n+++ b/config.ts\n@@ -1 +1 @@\n+const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz1234"`;

    const result = await validatePatch(db, "/repo", 1, {
      diff: secretDiff, message: "add config", baseCommit: "abc123",
    });

    expect(result.valid).toBe(true); // not stale
    expect(result.dryRunResult.secretWarnings.length).toBeGreaterThan(0);
    // Secrets are warnings, not hard blocks
    expect(result.dryRunResult.feasible).toBe(true);
  });
});
