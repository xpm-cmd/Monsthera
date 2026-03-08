import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";

function createTestDb() {
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

const now = () => new Date().toISOString();

describe("knowledge queries", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    sqlite = result.sqlite;
  });
  afterEach(() => sqlite.close());

  // ─── upsert ─────────────────────────────────────────────

  it("inserts a new knowledge entry", () => {
    const entry = queries.upsertKnowledge(db, {
      key: "decision:abc123",
      type: "decision",
      scope: "repo",
      title: "Use FTS5 for search",
      content: "FTS5 chosen over Zoekt for simplicity",
      tagsJson: JSON.stringify(["search", "architecture"]),
      status: "active",
      createdAt: now(),
      updatedAt: now(),
    });

    expect(entry.id).toBeGreaterThan(0);
    expect(entry.key).toBe("decision:abc123");
    expect(entry.title).toBe("Use FTS5 for search");
    expect(entry.status).toBe("active");
  });

  it("updates existing entry on upsert with same key", () => {
    const ts = now();
    queries.upsertKnowledge(db, {
      key: "gotcha:xyz789",
      type: "gotcha",
      scope: "global",
      title: "Original title",
      content: "Original content",
      createdAt: ts,
      updatedAt: ts,
    });

    const updated = queries.upsertKnowledge(db, {
      key: "gotcha:xyz789",
      type: "gotcha",
      scope: "global",
      title: "Updated title",
      content: "Updated content",
      tagsJson: JSON.stringify(["typescript"]),
      createdAt: ts,
      updatedAt: now(),
    });

    expect(updated.title).toBe("Updated title");
    expect(updated.content).toBe("Updated content");
    // Same ID — no duplicate
    expect(updated.id).toBeGreaterThan(0);
    const all = queries.queryKnowledge(db, {});
    expect(all.length).toBe(1);
  });

  // ─── getKnowledgeByKey ──────────────────────────────────

  it("retrieves entry by key", () => {
    queries.upsertKnowledge(db, {
      key: "pattern:abc",
      type: "pattern",
      scope: "repo",
      title: "Singleton pattern",
      content: "Used for DB connections",
      createdAt: now(),
      updatedAt: now(),
    });

    const found = queries.getKnowledgeByKey(db, "pattern:abc");
    expect(found).toBeTruthy();
    expect(found!.title).toBe("Singleton pattern");
  });

  it("returns undefined for missing key", () => {
    expect(queries.getKnowledgeByKey(db, "nonexistent")).toBeUndefined();
  });

  // ─── queryKnowledge ─────────────────────────────────────

  it("defaults to active-only results", () => {
    const ts = now();
    queries.upsertKnowledge(db, { key: "k1", type: "decision", scope: "repo", title: "Active", content: "c", status: "active", createdAt: ts, updatedAt: ts });
    queries.upsertKnowledge(db, { key: "k2", type: "decision", scope: "repo", title: "Archived", content: "c", status: "archived", createdAt: ts, updatedAt: ts });

    const active = queries.queryKnowledge(db, {});
    expect(active.length).toBe(1);
    expect(active[0]!.title).toBe("Active");
  });

  it("queries archived entries when requested", () => {
    const ts = now();
    queries.upsertKnowledge(db, { key: "k1", type: "decision", scope: "repo", title: "Active", content: "c", status: "active", createdAt: ts, updatedAt: ts });
    queries.upsertKnowledge(db, { key: "k2", type: "gotcha", scope: "repo", title: "Archived", content: "c", status: "archived", createdAt: ts, updatedAt: ts });

    const archived = queries.queryKnowledge(db, { status: "archived" });
    expect(archived.length).toBe(1);
    expect(archived[0]!.title).toBe("Archived");
  });

  it("filters by type", () => {
    const ts = now();
    queries.upsertKnowledge(db, { key: "k1", type: "decision", scope: "repo", title: "D1", content: "c", createdAt: ts, updatedAt: ts });
    queries.upsertKnowledge(db, { key: "k2", type: "gotcha", scope: "repo", title: "G1", content: "c", createdAt: ts, updatedAt: ts });
    queries.upsertKnowledge(db, { key: "k3", type: "decision", scope: "repo", title: "D2", content: "c", createdAt: ts, updatedAt: ts });

    const decisions = queries.queryKnowledge(db, { type: "decision" });
    expect(decisions.length).toBe(2);
    expect(decisions.every((d) => d.type === "decision")).toBe(true);
  });

  it("filters by tags with AND logic", () => {
    const ts = now();
    queries.upsertKnowledge(db, { key: "k1", type: "pattern", scope: "repo", title: "P1", content: "c", tagsJson: JSON.stringify(["ts", "onnx"]), createdAt: ts, updatedAt: ts });
    queries.upsertKnowledge(db, { key: "k2", type: "pattern", scope: "repo", title: "P2", content: "c", tagsJson: JSON.stringify(["ts"]), createdAt: ts, updatedAt: ts });
    queries.upsertKnowledge(db, { key: "k3", type: "pattern", scope: "repo", title: "P3", content: "c", tagsJson: JSON.stringify(["onnx"]), createdAt: ts, updatedAt: ts });

    // Both tags required
    const both = queries.queryKnowledge(db, { tags: ["ts", "onnx"] });
    expect(both.length).toBe(1);
    expect(both[0]!.title).toBe("P1");

    // Single tag
    const tsOnly = queries.queryKnowledge(db, { tags: ["ts"] });
    expect(tsOnly.length).toBe(2);
  });

  it("handles entries with no tags gracefully", () => {
    const ts = now();
    queries.upsertKnowledge(db, { key: "k1", type: "context", scope: "repo", title: "No tags", content: "c", createdAt: ts, updatedAt: ts });

    const results = queries.queryKnowledge(db, { tags: ["anything"] });
    expect(results.length).toBe(0);

    // But appears without tag filter
    const all = queries.queryKnowledge(db, {});
    expect(all.length).toBe(1);
  });

  // ─── archive ────────────────────────────────────────────

  it("archives an entry (soft delete)", () => {
    const ts = now();
    queries.upsertKnowledge(db, { key: "k1", type: "plan", scope: "repo", title: "Plan A", content: "steps", createdAt: ts, updatedAt: ts });

    queries.archiveKnowledge(db, "k1");

    // No longer in active results
    const active = queries.queryKnowledge(db, {});
    expect(active.length).toBe(0);

    // Still in archived results
    const archived = queries.queryKnowledge(db, { status: "archived" });
    expect(archived.length).toBe(1);
    expect(archived[0]!.status).toBe("archived");
  });

  // ─── delete ─────────────────────────────────────────────

  it("permanently deletes an entry", () => {
    const ts = now();
    queries.upsertKnowledge(db, { key: "k1", type: "solution", scope: "repo", title: "Fix X", content: "do Y", createdAt: ts, updatedAt: ts });

    queries.deleteKnowledge(db, "k1");

    // Gone from everything
    expect(queries.getKnowledgeByKey(db, "k1")).toBeUndefined();
    expect(queries.queryKnowledge(db, {}).length).toBe(0);
    expect(queries.queryKnowledge(db, { status: "archived" }).length).toBe(0);
  });

  it("delete on non-existent key is a no-op", () => {
    // Should not throw
    queries.deleteKnowledge(db, "nonexistent");
  });
});
