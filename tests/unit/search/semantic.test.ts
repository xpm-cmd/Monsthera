import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import {
  cosineSimilarity,
  blendScores,
  buildEmbeddingText,
  mergeResults,
  SemanticReranker,
} from "../../../src/search/semantic.js";

// ── Pure function tests (no model needed) ──────────────────────────

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("returns 0 for zero vectors", () => {
    const zero = new Float32Array([0, 0, 0]);
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(zero, v)).toBe(0);
    expect(cosineSimilarity(zero, zero)).toBe(0);
  });

  it("handles unit vectors (dot product)", () => {
    const a = new Float32Array([1 / Math.SQRT2, 1 / Math.SQRT2]);
    const b = new Float32Array([1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1 / Math.SQRT2, 5);
  });
});

describe("blendScores", () => {
  it("uses default alpha=0.5", () => {
    expect(blendScores(1.0, 0.0)).toBeCloseTo(0.5, 5);
    expect(blendScores(0.0, 1.0)).toBeCloseTo(0.5, 5);
  });

  it("respects custom alpha", () => {
    expect(blendScores(1.0, 0.0, 0.0)).toBeCloseTo(1.0, 5); // all FTS5
    expect(blendScores(1.0, 0.0, 1.0)).toBeCloseTo(0.0, 5); // all semantic
  });

  it("averages at alpha=0.5", () => {
    expect(blendScores(0.8, 0.4, 0.5)).toBeCloseTo(0.6, 5);
  });
});

describe("buildEmbeddingText", () => {
  it("includes path, language, summary, and symbols with kinds", () => {
    const result = buildEmbeddingText({
      path: "src/auth/login.ts",
      language: "typescript",
      summary: "Functions: login | 30 lines",
      symbolsJson: JSON.stringify([{ name: "login", kind: "function" }, { name: "User", kind: "class" }]),
    });
    expect(result).toContain("file: src/auth/login.ts");
    expect(result).toContain("language: typescript");
    expect(result).toContain("Functions: login | 30 lines");
    expect(result).toContain("function login, class User");
  });

  it("includes import sources when provided", () => {
    const result = buildEmbeddingText({
      path: "src/server.ts",
      language: "typescript",
      summary: "Main server",
      symbolsJson: "[]",
      imports: ["express", "./routes.js", "drizzle-orm"],
    });
    expect(result).toContain("imports: express, ./routes.js, drizzle-orm");
  });

  it("includes leading comment when provided", () => {
    const result = buildEmbeddingText({
      path: "src/core.ts",
      language: "typescript",
      summary: "Core module",
      symbolsJson: "[]",
      leadingComment: "This module handles authentication and session management.",
    });
    expect(result).toContain("This module handles authentication and session management.");
  });

  it("truncates leading comment to 200 chars", () => {
    const longComment = "A".repeat(300);
    const result = buildEmbeddingText({
      path: "src/x.ts",
      language: null,
      summary: "",
      symbolsJson: "[]",
      leadingComment: longComment,
    });
    // Should contain at most 200 A's
    const aCount = (result.match(/A/g) || []).length;
    expect(aCount).toBeLessThanOrEqual(200);
  });

  it("handles empty symbols array", () => {
    const result = buildEmbeddingText({
      path: "test.ts",
      language: "typescript",
      summary: "summary",
      symbolsJson: "[]",
    });
    expect(result).toContain("summary");
    expect(result).not.toContain("symbols:");
  });

  it("handles malformed JSON in symbolsJson", () => {
    const result = buildEmbeddingText({
      path: "test.ts",
      language: null,
      summary: "summary",
      symbolsJson: "not json",
    });
    expect(result).toContain("summary");
  });

  it("handles null language", () => {
    const result = buildEmbeddingText({
      path: "Makefile",
      language: null,
      summary: "Build config",
      symbolsJson: "[]",
    });
    expect(result).toContain("file: Makefile");
    expect(result).not.toContain("language:");
  });

  it("works with symbols that have no kind", () => {
    const result = buildEmbeddingText({
      path: "x.ts",
      language: null,
      summary: "",
      symbolsJson: JSON.stringify([{ name: "foo" }]),
    });
    expect(result).toContain("symbols: foo");
  });
});

// ── Integration tests (in-memory DB, no model) ────────────────────

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(`
    CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, path TEXT NOT NULL, language TEXT, content_hash TEXT, summary TEXT, symbols_json TEXT, has_secrets INTEGER DEFAULT 0, secret_line_ranges TEXT, indexed_at TEXT, commit_sha TEXT, embedding BLOB);
  `);
  sqlite.exec("INSERT INTO repos (path, name, created_at) VALUES ('/r', 'r', '2024-01-01')");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

describe("SemanticReranker — embedding storage", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let reranker: SemanticReranker;

  beforeEach(() => {
    const result = createTestDb();
    sqlite = result.sqlite;
    db = result.db;
    reranker = new SemanticReranker({ sqlite, db });

    // Insert a test file
    sqlite.prepare(
      "INSERT INTO files (repo_id, path, language, summary, symbols_json) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "src/index.ts", "typescript", "Main entry", "[]");
  });

  afterEach(() => sqlite.close());

  it("stores and retrieves embeddings", () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    reranker.storeEmbedding(1, embedding);

    const retrieved = reranker.getEmbedding(1);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.length).toBe(4);
    expect(retrieved![0]).toBeCloseTo(0.1, 5);
    expect(retrieved![3]).toBeCloseTo(0.4, 5);
  });

  it("returns null for files without embeddings", () => {
    expect(reranker.getEmbedding(1)).toBeNull();
  });

  it("returns null for non-existent files", () => {
    expect(reranker.getEmbedding(999)).toBeNull();
  });
});

describe("SemanticReranker — rerank with injected embeddings", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let reranker: SemanticReranker;

  beforeEach(() => {
    const result = createTestDb();
    sqlite = result.sqlite;
    db = result.db;
    reranker = new SemanticReranker({ sqlite, db });

    // Insert test files with embeddings
    const ins = sqlite.prepare(
      "INSERT INTO files (repo_id, path, language, summary, symbols_json) VALUES (?, ?, ?, ?, ?)",
    );
    ins.run(1, "src/auth.ts", "typescript", "Auth module", JSON.stringify([{ name: "authenticate" }]));
    ins.run(1, "src/utils.ts", "typescript", "Utility functions", JSON.stringify([{ name: "format" }]));
    ins.run(1, "src/db.ts", "typescript", "Database layer", JSON.stringify([{ name: "query" }]));

    // auth.ts (id=1): embedding close to "authentication" query
    reranker.storeEmbedding(1, new Float32Array([0.9, 0.1, 0.0]));
    // utils.ts (id=2): orthogonal
    reranker.storeEmbedding(2, new Float32Array([0.0, 0.1, 0.9]));
    // db.ts (id=3): weakly related (low similarity to auth query)
    reranker.storeEmbedding(3, new Float32Array([0.1, 0.9, 0.0]));
  });

  afterEach(() => sqlite.close());

  it("re-orders results by semantic similarity", async () => {
    // Mock the embed method to return a known query embedding
    reranker.embed = async () => new Float32Array([0.9, 0.1, 0.0]);

    const results = [
      { path: "src/utils.ts", score: 10 },  // FTS5 ranked highest
      { path: "src/db.ts", score: 8 },
      { path: "src/auth.ts", score: 5 },     // FTS5 ranked lowest
    ];

    const reranked = await reranker.rerank("authentication", results, 1, 3);

    // auth.ts should now be first (highest semantic similarity)
    expect(reranked[0]!.path).toBe("src/auth.ts");
  });

  it("handles files without embeddings gracefully", async () => {
    // Insert a file without embedding
    sqlite.prepare(
      "INSERT INTO files (repo_id, path, language, summary, symbols_json) VALUES (?, ?, ?, ?, ?)",
    ).run(1, "src/noembedding.ts", "typescript", "No embedding", "[]");

    reranker.embed = async () => new Float32Array([0.9, 0.1, 0.0]);

    const results = [
      { path: "src/noembedding.ts", score: 10 },
      { path: "src/auth.ts", score: 5 },
    ];

    const reranked = await reranker.rerank("auth", results, 1, 2);
    expect(reranked.length).toBe(2);
  });

  it("returns original results when embed fails", async () => {
    reranker.embed = async () => null;

    const results = [
      { path: "src/utils.ts", score: 10 },
      { path: "src/auth.ts", score: 5 },
    ];

    const reranked = await reranker.rerank("test", results, 1, 2);
    expect(reranked[0]!.path).toBe("src/utils.ts"); // order unchanged
  });

  it("respects limit parameter", async () => {
    reranker.embed = async () => new Float32Array([0.9, 0.1, 0.0]);

    const results = [
      { path: "src/utils.ts", score: 10 },
      { path: "src/db.ts", score: 8 },
      { path: "src/auth.ts", score: 5 },
    ];

    const reranked = await reranker.rerank("auth", results, 1, 1);
    expect(reranked.length).toBe(1);
  });
});

// ── mergeResults (pure function) ──────────────────────────────────

describe("mergeResults", () => {
  it("blends scores with default alpha=0.5", () => {
    const fts5 = [{ path: "src/a.ts", score: 10 }];
    const vector = [{ path: "src/a.ts", score: 0.8 }];

    const merged = mergeResults(fts5, vector, 5);
    expect(merged.length).toBe(1);
    // FTS5 normalized = 10/10 = 1.0; blend = 0.5*0.8 + 0.5*1.0 = 0.9
    expect(merged[0]!.score).toBeCloseTo(0.9, 5);
  });

  it("blends scores with explicit alpha=0.6", () => {
    const fts5 = [{ path: "src/a.ts", score: 10 }];
    const vector = [{ path: "src/a.ts", score: 0.8 }];

    const merged = mergeResults(fts5, vector, 5, 0.6);
    expect(merged.length).toBe(1);
    // FTS5 normalized = 10/10 = 1.0; blend = 0.6*0.8 + 0.4*1.0 = 0.88
    expect(merged[0]!.score).toBeCloseTo(0.88, 5);
  });

  it("includes FTS5-only results with penalized score", () => {
    const fts5 = [{ path: "src/fts-only.ts", score: 10 }];
    const vector: { path: string; score: number }[] = [];

    const merged = mergeResults(fts5, vector, 5, 0.6);
    expect(merged.length).toBe(1);
    // FTS5 only: score = 1.0 * (1 - 0.6) = 0.4
    expect(merged[0]!.score).toBeCloseTo(0.4, 5);
  });

  it("includes vector-only results — the hybrid win", () => {
    const fts5: { path: string; score: number }[] = [];
    const vector = [{ path: "src/vec-only.ts", score: 0.9 }];

    const merged = mergeResults(fts5, vector, 5, 0.6);
    expect(merged.length).toBe(1);
    // Vector only: score = 0.9 * 0.6 = 0.54
    expect(merged[0]!.score).toBeCloseTo(0.54, 5);
  });

  it("deduplicates and ranks correctly with mixed sources", () => {
    const fts5 = [
      { path: "src/a.ts", score: 10 },  // high FTS5
      { path: "src/b.ts", score: 5 },   // medium FTS5
    ];
    const vector = [
      { path: "src/c.ts", score: 0.95 }, // vector-only, very relevant
      { path: "src/a.ts", score: 0.3 },  // overlaps with FTS5
    ];

    const merged = mergeResults(fts5, vector, 5, 0.6);
    expect(merged.length).toBe(3);
    // All three files present, no duplicates
    const paths = merged.map((r) => r.path);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/b.ts");
    expect(paths).toContain("src/c.ts");
  });

  it("preserves matchLines and snippet from FTS5", () => {
    const fts5 = [{ path: "src/a.ts", score: 10, matchLines: [5, 10], snippet: "line content" }];
    const vector = [{ path: "src/a.ts", score: 0.7 }];

    const merged = mergeResults(fts5, vector, 5);
    expect(merged[0]!.matchLines).toEqual([5, 10]);
    expect(merged[0]!.snippet).toBe("line content");
  });

  it("returns empty array for two empty inputs", () => {
    const merged = mergeResults([], [], 5);
    expect(merged).toEqual([]);
  });

  it("respects limit parameter", () => {
    const fts5 = [
      { path: "src/a.ts", score: 10 },
      { path: "src/b.ts", score: 8 },
    ];
    const vector = [
      { path: "src/c.ts", score: 0.9 },
      { path: "src/d.ts", score: 0.8 },
    ];

    const merged = mergeResults(fts5, vector, 2);
    expect(merged.length).toBe(2);
  });
});

// ── vectorSearch (integration, in-memory DB) ──────────────────────

describe("SemanticReranker — vectorSearch", () => {
  let sqlite: InstanceType<typeof Database>;
  let db: ReturnType<typeof createTestDb>["db"];
  let reranker: SemanticReranker;

  beforeEach(() => {
    const result = createTestDb();
    sqlite = result.sqlite;
    db = result.db;
    reranker = new SemanticReranker({ sqlite, db });

    // Insert files with embeddings
    const ins = sqlite.prepare(
      "INSERT INTO files (repo_id, path, language, summary, symbols_json) VALUES (?, ?, ?, ?, ?)",
    );
    ins.run(1, "src/auth.ts", "typescript", "Auth module", "[]");
    ins.run(1, "src/utils.ts", "typescript", "Utilities", "[]");
    ins.run(1, "src/noembedding.ts", "typescript", "No emb", "[]");

    // auth.ts (id=1): close to query direction [1,0,0]
    reranker.storeEmbedding(1, new Float32Array([0.9, 0.1, 0.0]));
    // utils.ts (id=2): orthogonal
    reranker.storeEmbedding(2, new Float32Array([0.0, 0.1, 0.9]));
    // noembedding.ts (id=3): no embedding stored
  });

  afterEach(() => sqlite.close());

  it("returns files ranked by cosine similarity", async () => {
    reranker.embed = async () => new Float32Array([1.0, 0.0, 0.0]);

    const results = await reranker.vectorSearch("auth query", 1, 5);
    expect(results.length).toBe(2); // only 2 files have embeddings
    expect(results[0]!.path).toBe("src/auth.ts"); // most similar to [1,0,0]
    expect(results[1]!.path).toBe("src/utils.ts");
    // Scores should be in [0, 1] (mapped from cosine [-1,1])
    expect(results[0]!.score).toBeGreaterThan(0.5);
  });

  it("returns empty when embed fails", async () => {
    reranker.embed = async () => null;
    const results = await reranker.vectorSearch("anything", 1, 5);
    expect(results).toEqual([]);
  });

  it("skips files without embeddings", async () => {
    reranker.embed = async () => new Float32Array([1.0, 0.0, 0.0]);
    const results = await reranker.vectorSearch("test", 1, 10);
    const paths = results.map((r) => r.path);
    expect(paths).not.toContain("src/noembedding.ts");
  });

  it("respects limit parameter", async () => {
    reranker.embed = async () => new Float32Array([1.0, 0.0, 0.0]);
    const results = await reranker.vectorSearch("test", 1, 1);
    expect(results.length).toBe(1);
  });

  it("returns empty for repo with no embeddings", async () => {
    reranker.embed = async () => new Float32Array([1.0, 0.0, 0.0]);
    const results = await reranker.vectorSearch("test", 999, 5); // non-existent repo
    expect(results).toEqual([]);
  });
});
