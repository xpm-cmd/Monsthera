import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { FTS5Backend } from "../../../src/search/fts5.js";
import { buildCodeSearchDebug } from "../../../src/search/debug.js";

describe("buildCodeSearchDebug", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let fts5: FTS5Backend;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, path TEXT NOT NULL, language TEXT, content_hash TEXT, summary TEXT, symbols_json TEXT, has_secrets INTEGER DEFAULT 0, secret_line_ranges TEXT, indexed_at TEXT, commit_sha TEXT, embedding BLOB);
    `);
    db = drizzle(sqlite, { schema });
    const now = new Date().toISOString();
    sqlite.prepare(`INSERT INTO repos (path, name, created_at) VALUES (?, ?, ?)`).run("/repo", "repo", now);
    sqlite.prepare(`
      INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, "src/dashboard/html.ts", "typescript", "h1", "repository name header", "[]", now, "abc1234");
    sqlite.prepare(`
      INSERT INTO files (repo_id, path, language, content_hash, summary, symbols_json, indexed_at, commit_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1, "src/dashboard/api.ts", "typescript", "h2", "dashboard metrics endpoint", "[]", now, "abc1234");
    fts5 = new FTS5Backend(sqlite, db);
    fts5.initFtsTable();
    fts5.rebuildIndex(1);
  });

  afterEach(() => sqlite.close());

  it("reports sanitized FTS terms and lexical results", async () => {
    const result = await buildCodeSearchDebug({
      sqlite,
      db,
      repoId: 1,
      runtimeBackend: "fts5",
      lexicalBackend: "fts5",
      lexicalSearch: (query, repoId, limit, scope) => fts5.search(query, repoId, limit, scope),
      semanticReranker: null,
    }, {
      query: "repository name header",
      limit: 5,
    });

    expect(result.sanitizedQuery).toBe("\"repository\" OR \"name\" OR \"header\"");
    expect(result.lexicalBackend).toBe("fts5");
    expect(result.semanticAvailable).toBe(false);
    expect(result.lexicalResults[0]?.path).toBe("src/dashboard/html.ts");
    expect(result.vectorResults).toEqual([]);
    expect(result.mergedResults[0]?.source).toBe("fts5");
  });

  it("includes semantic and hybrid sources when semantic results are available", async () => {
    const result = await buildCodeSearchDebug({
      sqlite,
      db,
      repoId: 1,
      runtimeBackend: "fts5+semantic",
      lexicalBackend: "fts5",
      lexicalSearch: (query, repoId, limit, scope) => fts5.search(query, repoId, limit, scope),
      semanticReranker: {
        isAvailable: () => true,
        vectorSearch: async () => [
          { path: "src/dashboard/api.ts", score: 0.9 },
          { path: "src/dashboard/html.ts", score: 0.7 },
        ],
      } as never,
    }, {
      query: "dashboard metrics",
      limit: 5,
    });

    expect(result.semanticAvailable).toBe(true);
    expect(result.vectorResults).toHaveLength(2);
    expect(result.mergedResults.some((entry) => entry.source === "hybrid")).toBe(true);
  });

  it("reports zoekt as the lexical backend when runtime uses zoekt", async () => {
    const result = await buildCodeSearchDebug({
      sqlite,
      db,
      repoId: 1,
      runtimeBackend: "zoekt+semantic",
      lexicalBackend: "zoekt",
      lexicalSearch: async () => [
        { path: "src/dashboard/api.ts", score: 0.91 },
        { path: "src/dashboard/html.ts", score: 0.67 },
      ],
      semanticReranker: {
        isAvailable: () => true,
        vectorSearch: async () => [
          { path: "src/dashboard/html.ts", score: 0.88 },
        ],
      } as never,
    }, {
      query: "dashboard metrics",
      limit: 5,
    });

    expect(result.lexicalBackend).toBe("zoekt");
    expect(result.sanitizedQuery).toBeNull();
    expect(result.lexicalResults[0]?.source).toBe("zoekt");
    expect(result.mergedResults.length).toBeGreaterThan(0);
  });
});
