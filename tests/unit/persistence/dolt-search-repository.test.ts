import { describe, it, expect, vi } from "vitest";
import type { Pool, PoolConnection, ResultSetHeader } from "mysql2/promise";
import { DoltSearchIndexRepository } from "../../../src/persistence/dolt-search-repository.js";

describe("DoltSearchIndexRepository", () => {
  it("removes inverted-index rows before deleting the parent document", async () => {
    const query = vi.fn<PoolConnection["query"]>()
      .mockResolvedValue([{} as ResultSetHeader, []]);
    const beginTransaction = vi.fn<PoolConnection["beginTransaction"]>().mockResolvedValue(undefined);
    const commit = vi.fn<PoolConnection["commit"]>().mockResolvedValue(undefined);
    const rollback = vi.fn<PoolConnection["rollback"]>().mockResolvedValue(undefined);
    const release = vi.fn<PoolConnection["release"]>().mockImplementation(() => {});

    const connection = {
      beginTransaction,
      query,
      commit,
      rollback,
      release,
    } as unknown as PoolConnection;

    const getConnection = vi.fn<Pool["getConnection"]>().mockResolvedValue(connection);
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
      "DELETE FROM search_documents WHERE id = ?",
      ["doc-1"],
    );
    expect(commit).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
  });
});
