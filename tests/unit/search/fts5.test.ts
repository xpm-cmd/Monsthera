import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { FTS5Backend } from "../../../src/search/fts5.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, path TEXT NOT NULL, language TEXT, content_hash TEXT, summary TEXT, symbols_json TEXT, has_secrets INTEGER DEFAULT 0, secret_line_ranges TEXT, indexed_at TEXT, commit_sha TEXT, embedding BLOB);
  `);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

function insertTestFiles(sqlite: InstanceType<typeof Database>, repoId: number) {
  const ins = sqlite.prepare(
    "INSERT INTO files (repo_id, path, language, summary, symbols_json) VALUES (?, ?, ?, ?, ?)",
  );
  ins.run(repoId, "src/server.ts", "typescript", "Functions: createServer | 50 lines",
    JSON.stringify([{ name: "createServer" }, { name: "handleRequest" }]));
  ins.run(repoId, "src/db/client.ts", "typescript", "Functions: createDatabase | 25 lines",
    JSON.stringify([{ name: "createDatabase" }]));
  ins.run(repoId, "main.py", "python", "Functions: main | Classes: App | 80 lines",
    JSON.stringify([{ name: "main" }, { name: "App" }]));
}

describe("FTS5Backend", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;
  let fts5: FTS5Backend;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    sqlite = result.sqlite;
    sqlite.exec("INSERT INTO repos (path, name, created_at) VALUES ('/r', 'r', '2024-01-01')");
    insertTestFiles(sqlite, 1);
    fts5 = new FTS5Backend(sqlite, db);
    fts5.initFtsTable();
    fts5.rebuildIndex(1);
  });

  afterEach(() => sqlite.close());

  it("is always available", async () => {
    expect(await fts5.isAvailable()).toBe(true);
  });

  it("finds files by path", async () => {
    const results = await fts5.search("server", 1);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.path).toBe("src/server.ts");
  });

  it("finds files by symbol name", async () => {
    const results = await fts5.search("createDatabase", 1);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.path).toBe("src/db/client.ts");
  });

  it("returns empty for no matches", async () => {
    const results = await fts5.search("nonexistent_xyz", 1);
    expect(results.length).toBe(0);
  });

  it("handles empty query", async () => {
    const results = await fts5.search("", 1);
    expect(results.length).toBe(0);
  });

  it("respects limit", async () => {
    const results = await fts5.search("src", 1, 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("logs warnings and falls back when file symbol JSON is malformed", () => {
    const warn = vi.fn();
    sqlite.prepare("UPDATE files SET symbols_json = ? WHERE path = ?").run("{bad json", "src/server.ts");

    const warnedFts5 = new FTS5Backend(sqlite, db, warn);
    warnedFts5.initFtsTable();
    warnedFts5.rebuildIndex(1);

    const results = warnedFts5.search("server", 1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("FTS5 file symbol parse failed for src/server.ts"));
    return expect(results).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/server.ts" }),
    ]));
  });

  it("does not penalize test files when the query is explicitly test-related", async () => {
    sqlite.prepare(
      "INSERT INTO files (repo_id, path, language, summary, symbols_json) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "src/auth.ts", "typescript", "Authentication flow", JSON.stringify([{ name: "authenticate" }]));
    sqlite.prepare(
      "INSERT INTO files (repo_id, path, language, summary, symbols_json) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "tests/auth.e2e.test.ts", "typescript", "Authentication unit testing flow", JSON.stringify([{ name: "authenticate" }]));

    fts5.initFtsTable();
    fts5.rebuildIndex(1);

    const results = await fts5.search("unit testing authenticate", 1, 10);
    expect(results[0]?.path).toBe("tests/auth.e2e.test.ts");
  });
});
