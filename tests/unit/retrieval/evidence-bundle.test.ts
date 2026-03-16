import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { buildEvidenceBundle } from "../../../src/retrieval/evidence-bundle.js";
import type { SearchResult } from "../../../src/search/interface.js";

vi.mock("../../../src/git/operations.js", () => ({
  getFileContent: vi.fn().mockResolvedValue("const x = 1;\n"),
}));

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  // Note: using sqlite.prepare().run() for each statement (no shell usage)
  for (const stmt of [
    `CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, path TEXT NOT NULL, language TEXT, content_hash TEXT, summary TEXT, symbols_json TEXT, has_secrets INTEGER DEFAULT 0, secret_line_ranges TEXT, indexed_at TEXT, commit_sha TEXT, embedding BLOB)`,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, type TEXT NOT NULL, key TEXT NOT NULL UNIQUE, content TEXT NOT NULL, metadata_json TEXT, linked_paths_json TEXT, agent_id TEXT, session_id TEXT, commit_sha TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  ]) {
    sqlite.prepare(stmt).run();
  }
  return { db: drizzle(sqlite, { schema }), sqlite };
}

describe("buildEvidenceBundle", () => {
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: InstanceType<typeof Database>;

  beforeEach(() => {
    const result = createTestDb();
    db = result.db;
    sqlite = result.sqlite;

    sqlite.prepare(`INSERT INTO repos (path, name, created_at) VALUES (?, ?, ?)`).run("/repo", "repo", "2024-01-01");
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, summary, symbols_json, commit_sha) VALUES (?, ?, ?, ?, ?, ?)`).run(1, "src/index.ts", "typescript", "Main entry", "[]", "abc123");
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, summary, symbols_json, commit_sha) VALUES (?, ?, ?, ?, ?, ?)`).run(1, "src/utils.ts", "typescript", "Utility helpers", JSON.stringify([{ name: "helper", kind: "function", line: 1 }]), "abc123");
  });

  afterEach(() => sqlite.close());

  it("builds a bundle from search results", async () => {
    const searchResults: SearchResult[] = [
      { path: "src/index.ts", score: 0.9 },
      { path: "src/utils.ts", score: 0.7 },
    ];

    const bundle = await buildEvidenceBundle({
      query: "entry point",
      repoId: 1,
      repoPath: "/repo",
      commit: "abc123",
      trustTier: "A",
      searchBackend: "fts5",
      searchResults,
      db,
      expand: false,
    });

    expect(bundle.bundleId).toBeTruthy();
    expect(bundle.commit).toBe("abc123");
    expect(bundle.query).toBe("entry point");
    expect(bundle.trustTier).toBe("A");
    expect(bundle.candidates).toHaveLength(2);
    expect(bundle.candidates[0]!.path).toBe("src/index.ts");
    expect(bundle.candidates[1]!.summary).toBe("Utility helpers");
    expect(bundle.expanded).toHaveLength(0);
  });

  it("produces deterministic bundle IDs", async () => {
    const searchResults: SearchResult[] = [{ path: "src/index.ts", score: 0.9 }];
    const opts = {
      query: "test",
      repoId: 1,
      repoPath: "/repo",
      commit: "abc123",
      trustTier: "A" as const,
      searchBackend: "fts5" as const,
      searchResults,
      db,
      expand: false,
    };

    const b1 = await buildEvidenceBundle(opts);
    const b2 = await buildEvidenceBundle(opts);
    expect(b1.bundleId).toBe(b2.bundleId);
  });

  it("sets code_stripped for Tier B", async () => {
    const bundle = await buildEvidenceBundle({
      query: "test",
      repoId: 1,
      repoPath: "/repo",
      commit: "abc123",
      trustTier: "B",
      searchBackend: "fts5",
      searchResults: [{ path: "src/index.ts", score: 0.9 }],
      db,
      expand: true,
    });

    expect(bundle.redactionPolicy).toBe("code_stripped");
    expect(bundle.expanded).toHaveLength(0);
  });

  it("handles empty search results", async () => {
    const bundle = await buildEvidenceBundle({
      query: "nonexistent",
      repoId: 1,
      repoPath: "/repo",
      commit: "abc123",
      trustTier: "A",
      searchBackend: "fts5",
      searchResults: [],
      db,
      expand: false,
    });

    expect(bundle.candidates).toHaveLength(0);
  });

  it("skips files not found in index", async () => {
    const bundle = await buildEvidenceBundle({
      query: "test",
      repoId: 1,
      repoPath: "/repo",
      commit: "abc123",
      trustTier: "A",
      searchBackend: "fts5",
      searchResults: [{ path: "nonexistent.ts", score: 0.5 }],
      db,
      expand: false,
    });

    expect(bundle.candidates).toHaveLength(0);
  });

  it("limits expanded files when maxFiles is set", async () => {
    const searchResults: SearchResult[] = [
      { path: "src/index.ts", score: 0.9 },
      { path: "src/utils.ts", score: 0.7 },
    ];

    const bundle = await buildEvidenceBundle({
      query: "test",
      repoId: 1,
      repoPath: "/repo",
      commit: "abc123",
      trustTier: "A",
      searchBackend: "fts5",
      searchResults,
      db,
      expand: true,
      maxFiles: 1,
    });

    expect(bundle.candidates).toHaveLength(2);
    expect(bundle.expanded).toHaveLength(1);
    expect(bundle.expanded[0]!.path).toBe("src/index.ts");
  });

  it("expands all candidates when maxFiles is omitted", async () => {
    const searchResults: SearchResult[] = [
      { path: "src/index.ts", score: 0.9 },
      { path: "src/utils.ts", score: 0.7 },
    ];

    const bundle = await buildEvidenceBundle({
      query: "test",
      repoId: 1,
      repoPath: "/repo",
      commit: "abc123",
      trustTier: "A",
      searchBackend: "fts5",
      searchResults,
      db,
      expand: true,
    });

    expect(bundle.candidates).toHaveLength(2);
    expect(bundle.expanded).toHaveLength(2);
  });
});
