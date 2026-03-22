import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { initDatabase } from "../../src/db/init.js";
import * as queries from "../../src/db/queries.js";
import { fullIndex, getIndexedCommit, incrementalIndex } from "../../src/indexing/indexer.js";
import { FTS5Backend } from "../../src/search/fts5.js";

/**
 * Integration test: creates a real git repo, indexes it, then searches via FTS5.
 * Validates the full pipeline: git → indexer → SQLite → FTS5 → ranked results.
 */
describe("index-and-search integration", () => {
  let tmpDir: string;
  let db: ReturnType<typeof initDatabase>["db"];
  let sqlite: ReturnType<typeof initDatabase>["sqlite"];
  let repoId: number;

  beforeAll(async () => {
    // Create a temp git repo with sample files
    tmpDir = mkdtempSync(join(tmpdir(), "monsthera-integ-"));

    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "test@monsthera.dev"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir });

    // Create source files with distinct content
    mkdirSync(join(tmpDir, "src"), { recursive: true });

    writeFileSync(
      join(tmpDir, "src", "auth.ts"),
      `export function authenticateUser(username: string, password: string): boolean {
  // Validate credentials against the database
  return username === "admin" && password === "secret";
}
`,
    );

    writeFileSync(
      join(tmpDir, "src", "database.ts"),
      `export class DatabaseConnection {
  private pool: any;
  connect(url: string): void { this.pool = url; }
  query(sql: string): any[] { return []; }
}
`,
    );

    writeFileSync(
      join(tmpDir, "src", "api.ts"),
      `import { authenticateUser } from "./auth";
import { DatabaseConnection } from "./database";

export function handleRequest(path: string): string {
  const db = new DatabaseConnection();
  if (path === "/login") return authenticateUser("admin", "pass") ? "ok" : "fail";
  return "not found";
}
`,
    );

    writeFileSync(
      join(tmpDir, "README.md"),
      `# Test Project\n\nA sample project for testing Monsthera indexing.\n`,
    );

    execFileSync("git", ["add", "-A"], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: tmpDir });

    // Initialize Monsthera DB
    const result = initDatabase({ repoPath: tmpDir, monstheraDir: ".monsthera", dbName: "test.db" });
    db = result.db;
    sqlite = result.sqlite;

    const repo = queries.upsertRepo(db, tmpDir, "test-repo");
    repoId = repo.id;

    // Run full index
    await fullIndex({
      repoPath: tmpDir,
      repoId,
      db,
      onProgress: () => {},
    });

    // Build FTS5 index
    const fts5 = new FTS5Backend(sqlite, db);
    fts5.initFtsTable();
    fts5.rebuildIndex(repoId);
  });

  afterAll(() => {
    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("indexes all source files", () => {
    const count = queries.getFileCount(db, repoId);
    // 3 .ts files + README.md = 4 files
    expect(count).toBeGreaterThanOrEqual(3);
  });

  it("finds authentication-related files via FTS5 search", async () => {
    const fts5 = new FTS5Backend(sqlite, db);
    const results = await fts5.search("authenticateUser", repoId);

    expect(results.length).toBeGreaterThanOrEqual(1);
    const paths = results.map((r) => r.path);
    expect(paths.some((p) => p.includes("auth.ts"))).toBe(true);
  });

  it("ranks exact matches higher than indirect references", async () => {
    const fts5 = new FTS5Backend(sqlite, db);
    const results = await fts5.search("DatabaseConnection", repoId);

    expect(results.length).toBeGreaterThanOrEqual(1);
    // database.ts defines the class — should rank highest
    expect(results[0]!.path).toContain("database.ts");
  });

  it("returns empty results for nonsense queries", async () => {
    const fts5 = new FTS5Backend(sqlite, db);
    const results = await fts5.search("xyzzy_nonexistent_symbol_42", repoId);

    expect(results).toHaveLength(0);
  });

  it("respects scope filtering", async () => {
    const fts5 = new FTS5Backend(sqlite, db);
    // Search with scope limited to src/ directory
    const scoped = await fts5.search("import", repoId, 20, "src/");

    // All results should be under src/
    for (const r of scoped) {
      expect(r.path.startsWith("src/")).toBe(true);
    }
  });

  it("incrementally reindexes committed changes", async () => {
    const previousCommit = getIndexedCommit(db, repoId);
    expect(previousCommit).toBeTruthy();

    writeFileSync(
      join(tmpDir, "src", "auth.ts"),
      `export function authorizeToken(token: string): boolean {
  return token.startsWith("tok_");
}
`,
    );

    execFileSync("git", ["add", "-A"], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "update auth symbol"], { cwd: tmpDir });

    const result = await incrementalIndex(previousCommit!, {
      repoPath: tmpDir,
      repoId,
      db,
      onProgress: () => {},
    });

    expect(result.filesIndexed).toBeGreaterThanOrEqual(1);

    const fts5 = new FTS5Backend(sqlite, db);
    fts5.initFtsTable();
    fts5.rebuildIndex(repoId);
    const results = await fts5.search("authorizeToken", repoId);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.path).toContain("auth.ts");
    expect(getIndexedCommit(db, repoId)).toBe(result.commit);
  });
});
