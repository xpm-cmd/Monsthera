import { describe, it, expect, vi } from "vitest";
import type { Pool, PoolConnection } from "mysql2/promise";
import { DoltSearchIndexRepository } from "../../../src/persistence/dolt-search-repository.js";
import { SCHEMA_STATEMENTS } from "../../../src/persistence/schema.js";

// mysql2's `Pool["query"]` is a deeply overloaded function whose TS
// supertype demands `(options: QueryOptions, values?: QueryValues) => ...`.
// Mocks with `(sql: string) => ...` are valid runtime shapes but don't fit
// that supertype, so we drop the explicit `vi.fn<Pool["query"]>()`
// parameterisation here and concentrate the type assertion at the
// assembly boundary (`as unknown as Pool` / `PoolConnection`). That way
// each mock stays expressive and the cast lies once, in a single place.

describe("DoltSearchIndexRepository", () => {
  it("declares a persisted embeddings table in the schema", () => {
    expect(SCHEMA_STATEMENTS.some((statement) => statement.includes("CREATE TABLE IF NOT EXISTS search_embeddings"))).toBe(true);
  });

  it("removes inverted-index rows before deleting the parent document", async () => {
    const query = vi.fn().mockResolvedValue([{}, []]);
    const beginTransaction = vi.fn().mockResolvedValue(undefined);
    const commit = vi.fn().mockResolvedValue(undefined);
    const rollback = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockImplementation(() => {});

    const connection = {
      beginTransaction,
      query,
      commit,
      rollback,
      release,
    } as unknown as PoolConnection;

    const getConnection = vi.fn().mockResolvedValue(connection);
    const pool = { getConnection } as unknown as Pool;

    const repo = new DoltSearchIndexRepository(pool);
    const result = await repo.removeArticle("doc-1");

    expect(result.ok).toBe(true);
    expect(query).toHaveBeenNthCalledWith(
      1,
      "DELETE FROM search_inverted_index WHERE doc_id = ?",
      ["doc-1"],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      "DELETE FROM search_embeddings WHERE doc_id = ?",
      ["doc-1"],
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      "DELETE FROM search_documents WHERE id = ?",
      ["doc-1"],
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("persists embeddings in Dolt when storing vectors", async () => {
    const query = vi.fn()
      .mockResolvedValue([{}, []])
      .mockResolvedValueOnce([[{ count: 1 }], []]);
    const pool = { query } as unknown as Pool;

    const repo = new DoltSearchIndexRepository(pool);
    const result = await repo.storeEmbedding("doc-1", [0.1, 0.2, 0.3]);

    expect(result.ok).toBe(true);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO search_embeddings"),
      ["doc-1", "[0.1,0.2,0.3]"],
    );
    expect(repo.embeddingCount).toBe(1);
  });

  it("hydrates persisted embeddings for semantic search after restart", async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("FROM search_embeddings e")) {
        return [[
          { id: "k-1", type: "knowledge", embedding_json: "[1,0]" },
          { id: "w-1", type: "work", embedding_json: "[0,1]" },
        ], []];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const pool = { query } as unknown as Pool;

    const repo = new DoltSearchIndexRepository(pool);
    const result = await repo.searchSemantic([1, 0], 5, "knowledge");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([{ id: "k-1", score: 1 }]);
    expect(repo.embeddingCount).toBe(2);
  });

  it("hydrates embedding count during canary so restart status sees semantic vectors", async () => {
    const query = vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql === "SELECT COUNT(*) as count FROM search_documents") {
        return [[{ count: 1 }], []];
      }
      if (sql.includes("FROM search_embeddings e")) {
        return [[
          { id: "k-1", type: "knowledge", embedding_json: "[1,0,0]" },
        ], []];
      }
      if (sql === "SELECT term FROM search_inverted_index LIMIT 1") {
        return [[{ term: "alpha" }], []];
      }
      if (sql.includes("SELECT DISTINCT doc_id FROM search_inverted_index WHERE term IN")) {
        expect(params).toEqual(["alpha"]);
        return [[{ doc_id: "k-1" }], []];
      }
      if (sql.includes("SELECT id, title, content, type, indexed_at FROM search_documents WHERE id IN")) {
        return [[
          { id: "k-1", title: "Alpha", content: "alpha beta", type: "knowledge", indexed_at: "2026-04-18T00:00:00Z" },
        ], []];
      }
      if (sql.includes("SELECT term, COUNT(*) as count FROM search_inverted_index WHERE term IN")) {
        return [[{ term: "alpha", count: 1 }], []];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const pool = { query } as unknown as Pool;

    const repo = new DoltSearchIndexRepository(pool);
    const canary = await repo.canary();

    expect(canary).toBe(true);
    expect(repo.size).toBe(1);
    expect(repo.embeddingCount).toBe(1);
  });
});
