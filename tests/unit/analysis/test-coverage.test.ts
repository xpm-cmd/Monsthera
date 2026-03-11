import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as schema from "../../../src/db/schema.js";
import * as queries from "../../../src/db/queries.js";
import { analyzeTestCoverage, TEST_COVERAGE_METHODOLOGY_VERSION } from "../../../src/analysis/test-coverage.js";

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

describe("structural test coverage analysis", () => {
  let repoPath: string;
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let repoId: number;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), "agora-test-coverage-"));
    mkdirSync(join(repoPath, "src", "auth"), { recursive: true });
    mkdirSync(join(repoPath, "src", "payments"), { recursive: true });
    mkdirSync(join(repoPath, "tests", "unit", "auth"), { recursive: true });

    const result = createTestDb();
    sqlite = result.sqlite;
    db = result.db;
    repoId = queries.upsertRepo(db, repoPath, "test").id;
  });

  afterEach(() => {
    sqlite.close();
    rmSync(repoPath, { recursive: true, force: true });
  });

  function insertFile(path: string, language: string) {
    return sqlite.prepare(
      "INSERT INTO files (repo_id, path, language, indexed_at, commit_sha) VALUES (?, ?, ?, datetime('now'), 'abc1234')",
    ).run(repoId, path, language);
  }

  function insertImport(sourceFileId: number, targetPath: string, kind = "import") {
    sqlite.prepare(
      "INSERT INTO imports (source_file_id, target_path, kind) VALUES (?, ?, ?)",
    ).run(sourceFileId, targetPath, kind);
  }

  it("returns high-confidence tested when naming and imports both match", async () => {
    writeFileSync(join(repoPath, "src", "auth", "login.ts"), "export function login() {}\n");
    writeFileSync(join(repoPath, "tests", "unit", "auth", "login.test.ts"), "import { login } from '../../../src/auth/login.js';\n");

    insertFile("src/auth/login.ts", "typescript");
    const testFile = insertFile("tests/unit/auth/login.test.ts", "typescript");
    insertImport(Number(testFile.lastInsertRowid), "../../../src/auth/login.js");

    const result = await analyzeTestCoverage(db, repoId, repoPath, "src/auth/login.ts");

    expect(result).toMatchObject({
      filePath: "src/auth/login.ts",
      language: "typescript",
      methodologyVersion: TEST_COVERAGE_METHODOLOGY_VERSION,
      status: "tested",
      confidence: "high",
      signals: {
        namingMatches: 1,
        importMatches: 1,
        fallbackMatches: 0,
      },
    });
    expect(result.matchedTests[0]).toMatchObject({
      path: "tests/unit/auth/login.test.ts",
      matchKinds: ["naming", "imports"],
    });
  });

  it("returns untested when no structural match exists", async () => {
    writeFileSync(join(repoPath, "src", "payments", "refund.ts"), "export function refund() {}\n");
    writeFileSync(join(repoPath, "tests", "unit", "auth", "login.test.ts"), "export {}\n");

    insertFile("src/payments/refund.ts", "typescript");
    insertFile("tests/unit/auth/login.test.ts", "typescript");

    const result = await analyzeTestCoverage(db, repoId, repoPath, "src/payments/refund.ts");

    expect(result).toMatchObject({
      status: "untested",
      confidence: "low",
      matchedTests: [],
      signals: {
        namingMatches: 0,
        importMatches: 0,
        fallbackMatches: 0,
      },
    });
  });

  it("returns unknown when the target file exists but is not indexed", async () => {
    writeFileSync(join(repoPath, "src", "payments", "refund.ts"), "export function refund() {}\n");

    const result = await analyzeTestCoverage(db, repoId, repoPath, "src/payments/refund.ts");

    expect(result.status).toBe("unknown");
    expect(result.reason).toContain("not indexed");
  });
});
