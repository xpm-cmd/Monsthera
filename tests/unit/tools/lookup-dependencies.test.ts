import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL REFERENCES repos(id), path TEXT NOT NULL, language TEXT, content_hash TEXT, summary TEXT, symbols_json TEXT, has_secrets INTEGER DEFAULT 0, secret_line_ranges TEXT, indexed_at TEXT, commit_sha TEXT, embedding BLOB);
    CREATE TABLE imports (id INTEGER PRIMARY KEY AUTOINCREMENT, source_file_id INTEGER NOT NULL REFERENCES files(id), target_path TEXT NOT NULL, kind TEXT NOT NULL);
  `);
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("lookup_dependencies queries", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;
  let repoId: number;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    sqlite = result.sqlite;
    repoId = queries.upsertRepo(db, "/test", "test").id;
  });
  afterEach(() => sqlite.close());

  function insertFile(path: string) {
    return sqlite.prepare(
      "INSERT INTO files (repo_id, path, language, indexed_at) VALUES (?, ?, 'typescript', datetime('now'))",
    ).run(repoId, path);
  }

  function insertImport(sourceFileId: number, targetPath: string, kind = "import") {
    sqlite.prepare(
      "INSERT INTO imports (source_file_id, target_path, kind) VALUES (?, ?, ?)",
    ).run(sourceFileId, targetPath, kind);
  }

  it("returns forward imports for an indexed file", () => {
    const file = insertFile("src/tools/read-tools.ts");
    insertImport(Number(file.lastInsertRowid), "../db/queries.js", "import");
    insertImport(Number(file.lastInsertRowid), "../core/constants.js", "import");

    const dbFile = queries.getFileByPath(db, repoId, "src/tools/read-tools.ts");
    expect(dbFile).toBeTruthy();

    const forward = queries.getImportsForFile(db, dbFile!.id);
    expect(forward).toHaveLength(2);
    expect(forward.map((i) => i.targetPath)).toContain("../db/queries.js");
    expect(forward.map((i) => i.targetPath)).toContain("../core/constants.js");
  });

  it("returns reverse dependents (files that import a given path)", () => {
    const fileA = insertFile("src/a.ts");
    const fileB = insertFile("src/b.ts");
    const fileC = insertFile("src/c.ts");
    insertImport(Number(fileA.lastInsertRowid), "./shared/utils.js", "import");
    insertImport(Number(fileB.lastInsertRowid), "./shared/utils.js", "import");
    insertImport(Number(fileC.lastInsertRowid), "./other.js", "import");

    const reverse = queries.getFilesImporting(db, "shared/utils");
    expect(reverse).toHaveLength(2);
    const sourcePaths = reverse.map((r) => r.files.path);
    expect(sourcePaths).toContain("src/a.ts");
    expect(sourcePaths).toContain("src/b.ts");
  });

  it("returns empty arrays for a non-indexed file", () => {
    const file = queries.getFileByPath(db, repoId, "does/not/exist.ts");
    expect(file).toBeUndefined();
    const reverse = queries.getFilesImporting(db, "does/not/exist.ts");
    expect(reverse).toHaveLength(0);
  });

  it("returns empty forward for a file with no imports", () => {
    insertFile("src/leaf.ts");
    const file = queries.getFileByPath(db, repoId, "src/leaf.ts");
    const forward = queries.getImportsForFile(db, file!.id);
    expect(forward).toHaveLength(0);
  });

  it("preserves import kind (import, require, from)", () => {
    const file = insertFile("src/mixed.ts");
    const fid = Number(file.lastInsertRowid);
    insertImport(fid, "./a.js", "import");
    insertImport(fid, "./b.js", "require");
    insertImport(fid, "./c.js", "from");

    const forward = queries.getImportsForFile(db, fid);
    expect(forward).toHaveLength(3);
    const kinds = forward.map((i) => i.kind).sort();
    expect(kinds).toEqual(["from", "import", "require"]);
  });
});

describe("traceTransitiveDeps", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;
  let repoId: number;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    sqlite = result.sqlite;
    repoId = queries.upsertRepo(db, "/test", "test").id;
  });
  afterEach(() => sqlite.close());

  function insertFile(path: string) {
    return sqlite.prepare(
      "INSERT INTO files (repo_id, path, language, indexed_at) VALUES (?, ?, 'typescript', datetime('now'))",
    ).run(repoId, path);
  }

  function insertImport(sourceFileId: number, targetPath: string, kind = "import") {
    sqlite.prepare(
      "INSERT INTO imports (source_file_id, target_path, kind) VALUES (?, ?, ?)",
    ).run(sourceFileId, targetPath, kind);
  }

  it("traces outbound transitive dependencies with depth", () => {
    // A -> B -> C
    const fileA = insertFile("src/a.ts");
    const fileB = insertFile("src/b.ts");
    insertFile("src/c.ts");
    insertImport(Number(fileA.lastInsertRowid), "./b.ts", "import");
    insertImport(Number(fileB.lastInsertRowid), "./c.ts", "import");

    const deps = queries.traceTransitiveDeps(db, repoId, "src/a.ts", {
      direction: "outbound",
      maxDepth: 3,
    });

    expect(deps).toHaveLength(2);
    expect(deps[0]).toEqual({ path: "src/b.ts", depth: 1, isCycle: false });
    expect(deps[1]).toEqual({ path: "src/c.ts", depth: 2, isCycle: false });
  });

  it("traces inbound (reverse) dependencies", () => {
    // B -> A, C -> A
    const fileB = insertFile("src/b.ts");
    const fileC = insertFile("src/c.ts");
    insertFile("src/a.ts");
    insertImport(Number(fileB.lastInsertRowid), "./a.ts", "import");
    insertImport(Number(fileC.lastInsertRowid), "./a.ts", "import");

    const deps = queries.traceTransitiveDeps(db, repoId, "src/a.ts", {
      direction: "inbound",
      maxDepth: 3,
    });

    expect(deps).toHaveLength(2);
    const paths = deps.map(d => d.path).sort();
    expect(paths).toEqual(["src/b.ts", "src/c.ts"]);
    expect(deps.every(d => d.depth === 1)).toBe(true);
    expect(deps.every(d => !d.isCycle)).toBe(true);
  });

  it("detects cycles", () => {
    // A -> B -> A (cycle)
    const fileA = insertFile("src/a.ts");
    const fileB = insertFile("src/b.ts");
    insertImport(Number(fileA.lastInsertRowid), "./b.ts", "import");
    insertImport(Number(fileB.lastInsertRowid), "./a.ts", "import");

    const deps = queries.traceTransitiveDeps(db, repoId, "src/a.ts", {
      direction: "outbound",
      maxDepth: 3,
    });

    expect(deps).toHaveLength(2);
    expect(deps[0]).toEqual({ path: "src/b.ts", depth: 1, isCycle: false });
    expect(deps[1]).toEqual({ path: "src/a.ts", depth: 2, isCycle: true });
  });

  it("respects maxDepth limit", () => {
    // A -> B -> C -> D
    const fileA = insertFile("src/a.ts");
    const fileB = insertFile("src/b.ts");
    const fileC = insertFile("src/c.ts");
    insertFile("src/d.ts");
    insertImport(Number(fileA.lastInsertRowid), "./b.ts", "import");
    insertImport(Number(fileB.lastInsertRowid), "./c.ts", "import");
    insertImport(Number(fileC.lastInsertRowid), "./d.ts", "import");

    const deps = queries.traceTransitiveDeps(db, repoId, "src/a.ts", {
      direction: "outbound",
      maxDepth: 1,
    });

    expect(deps).toHaveLength(1);
    expect(deps[0]).toEqual({ path: "src/b.ts", depth: 1, isCycle: false });
  });

  it("returns empty array for a file with no imports", () => {
    insertFile("src/leaf.ts");

    const deps = queries.traceTransitiveDeps(db, repoId, "src/leaf.ts", {
      direction: "outbound",
      maxDepth: 3,
    });

    expect(deps).toHaveLength(0);
  });

  it("traces both directions simultaneously", () => {
    // B -> A -> C
    const fileA = insertFile("src/a.ts");
    const fileB = insertFile("src/b.ts");
    insertFile("src/c.ts");
    insertImport(Number(fileA.lastInsertRowid), "./c.ts", "import");
    insertImport(Number(fileB.lastInsertRowid), "./a.ts", "import");

    const deps = queries.traceTransitiveDeps(db, repoId, "src/a.ts", {
      direction: "both",
      maxDepth: 3,
    });

    // Depth 1: outbound src/c.ts, inbound src/b.ts
    // Depth 2: from src/b.ts outbound -> src/a.ts (cycle), from src/c.ts inbound -> src/a.ts (cycle)
    const nonCyclic = deps.filter(d => !d.isCycle);
    expect(nonCyclic).toHaveLength(2);
    const paths = nonCyclic.map(d => d.path).sort();
    expect(paths).toEqual(["src/b.ts", "src/c.ts"]);
    expect(nonCyclic.every(d => d.depth === 1)).toBe(true);
  });
});
