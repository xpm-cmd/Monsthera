import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../src/db/schema.js";
import * as queries from "../../src/db/queries.js";
import { FTS5Backend } from "../../src/search/fts5.js";

/**
 * Integration test: full knowledge lifecycle via real SQLite + FTS5.
 * Validates: store -> FTS5 search -> archive -> delete, with consistency at each step.
 */
describe("knowledge lifecycle integration", () => {
  let tmpDir: string;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sqlite: InstanceType<typeof Database>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agora-kl-"));
    sqlite = new Database(join(tmpDir, "test.db"));
    sqlite.pragma("journal_mode = WAL");

    // Create the knowledge table (matching production schema)
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

    // Also create a minimal repos + files table for FTS5Backend constructor
    sqlite.exec(`
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    sqlite.exec(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo_id INTEGER NOT NULL REFERENCES repos(id),
        path TEXT NOT NULL,
        language TEXT,
        summary TEXT,
        symbols TEXT,
        content TEXT,
        hash TEXT,
        tree_sitter_parsed INTEGER DEFAULT 0,
        embedding BLOB,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    db = drizzle(sqlite, { schema });
  });

  afterEach(() => {
    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const now = () => new Date().toISOString();

  it("stores knowledge and finds it via FTS5 search", () => {
    const ts = now();

    // Store 3 knowledge entries
    queries.upsertKnowledge(db, {
      key: "decision:use-fts5",
      type: "decision",
      scope: "repo",
      title: "Use FTS5 for full-text search",
      content: "FTS5 chosen over Zoekt for simplicity and zero external dependencies",
      tagsJson: JSON.stringify(["search", "architecture"]),
      createdAt: ts,
      updatedAt: ts,
    });

    queries.upsertKnowledge(db, {
      key: "gotcha:sqlite-wal",
      type: "gotcha",
      scope: "repo",
      title: "SQLite WAL mode required",
      content: "Without WAL, concurrent reads block writes. Always enable WAL pragma.",
      tagsJson: JSON.stringify(["sqlite", "performance"]),
      createdAt: ts,
      updatedAt: ts,
    });

    queries.upsertKnowledge(db, {
      key: "context:mcp-transport",
      type: "context",
      scope: "repo",
      title: "MCP transport layer",
      content: "Supports both stdio (default) and HTTP streamable transport for web clients.",
      tagsJson: JSON.stringify(["mcp", "transport"]),
      createdAt: ts,
      updatedAt: ts,
    });

    // Build FTS5 index
    const fts5 = new FTS5Backend(sqlite, db);
    fts5.initKnowledgeFts(sqlite);
    fts5.rebuildKnowledgeFts(sqlite);

    // Search: should find the FTS5 decision
    const results = fts5.searchKnowledge(sqlite, "FTS5 search");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.title).toContain("FTS5");
  });

  it("FTS5 search finds entries matching across title and content", () => {
    const ts = now();

    // Entry with "WAL" in title
    queries.upsertKnowledge(db, {
      key: "k1",
      type: "gotcha",
      scope: "repo",
      title: "WAL mode is essential for SQLite",
      content: "Database performance depends on write-ahead logging.",
      createdAt: ts,
      updatedAt: ts,
    });

    // Entry with "WAL" in content only
    queries.upsertKnowledge(db, {
      key: "k2",
      type: "context",
      scope: "repo",
      title: "Database configuration notes",
      content: "Remember to enable WAL pragma for concurrent access.",
      createdAt: ts,
      updatedAt: ts,
    });

    const fts5 = new FTS5Backend(sqlite, db);
    fts5.initKnowledgeFts(sqlite);
    fts5.rebuildKnowledgeFts(sqlite);

    const results = fts5.searchKnowledge(sqlite, "WAL");
    // Both entries should be found (WAL appears in title or content)
    expect(results.length).toBe(2);
    const titles = results.map((r) => r.title);
    expect(titles).toContain("WAL mode is essential for SQLite");
    expect(titles).toContain("Database configuration notes");
  });

  it("archived entries disappear from active queries and FTS5", () => {
    const ts = now();

    queries.upsertKnowledge(db, {
      key: "plan:migration",
      type: "plan",
      scope: "repo",
      title: "Database migration plan",
      content: "Step 1: backup. Step 2: migrate schema. Step 3: verify.",
      createdAt: ts,
      updatedAt: ts,
    });

    // Verify it's active
    const active = queries.queryKnowledge(db, {});
    expect(active.length).toBe(1);

    // Archive it
    queries.archiveKnowledge(db, "plan:migration");

    // Gone from active queries
    expect(queries.queryKnowledge(db, {}).length).toBe(0);

    // Rebuild FTS5: archived entries excluded
    const fts5 = new FTS5Backend(sqlite, db);
    fts5.initKnowledgeFts(sqlite);
    fts5.rebuildKnowledgeFts(sqlite);

    const results = fts5.searchKnowledge(sqlite, "migration");
    expect(results.length).toBe(0);

    // But still in archived queries
    const archived = queries.queryKnowledge(db, { status: "archived" });
    expect(archived.length).toBe(1);
  });

  it("deleted entries are permanently gone", () => {
    const ts = now();

    queries.upsertKnowledge(db, {
      key: "temp:scratch",
      type: "context",
      scope: "repo",
      title: "Temporary scratch notes",
      content: "This should be deleted after use.",
      createdAt: ts,
      updatedAt: ts,
    });

    // Verify it exists
    expect(queries.getKnowledgeByKey(db, "temp:scratch")).toBeTruthy();

    // Delete permanently
    queries.deleteKnowledge(db, "temp:scratch");

    // Gone from everywhere
    expect(queries.getKnowledgeByKey(db, "temp:scratch")).toBeUndefined();
    expect(queries.queryKnowledge(db, {}).length).toBe(0);
    expect(queries.queryKnowledge(db, { status: "archived" }).length).toBe(0);

    // FTS5 rebuild should have nothing
    const fts5 = new FTS5Backend(sqlite, db);
    fts5.initKnowledgeFts(sqlite);
    fts5.rebuildKnowledgeFts(sqlite);

    const results = fts5.searchKnowledge(sqlite, "scratch");
    expect(results.length).toBe(0);
  });

  it("upsert updates existing entry and FTS5 reflects changes", () => {
    const ts = now();

    queries.upsertKnowledge(db, {
      key: "decision:transport",
      type: "decision",
      scope: "repo",
      title: "Use stdio transport",
      content: "Stdio is simpler for CLI usage.",
      createdAt: ts,
      updatedAt: ts,
    });

    // Update via upsert
    queries.upsertKnowledge(db, {
      key: "decision:transport",
      type: "decision",
      scope: "repo",
      title: "Use HTTP transport",
      content: "HTTP chosen for web client compatibility. Stdio deprecated.",
      createdAt: ts,
      updatedAt: now(),
    });

    // Only 1 entry (no duplicate)
    const all = queries.queryKnowledge(db, {});
    expect(all.length).toBe(1);
    expect(all[0]!.title).toBe("Use HTTP transport");

    // FTS5 finds the updated content
    const fts5 = new FTS5Backend(sqlite, db);
    fts5.initKnowledgeFts(sqlite);
    fts5.rebuildKnowledgeFts(sqlite);

    const results = fts5.searchKnowledge(sqlite, "HTTP web client");
    expect(results.length).toBe(1);
    expect(results[0]!.title).toBe("Use HTTP transport");

    // Old content not findable (use terms only in old content, not in updated)
    const oldResults = fts5.searchKnowledge(sqlite, "simpler usage");
    expect(oldResults.length).toBe(0);
  });
});
