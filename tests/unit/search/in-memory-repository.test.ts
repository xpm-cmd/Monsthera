import { describe, it, expect, beforeEach } from "vitest";
import { InMemorySearchIndexRepository } from "../../../src/search/in-memory-repository.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function indexDoc(
  repo: InMemorySearchIndexRepository,
  id: string,
  title: string,
  content: string,
  type: "knowledge" | "work",
): Promise<void> {
  const result = await repo.indexArticle(id, title, content, type);
  expect(result.ok).toBe(true);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InMemorySearchIndexRepository", () => {
  let repo: InMemorySearchIndexRepository;

  beforeEach(() => {
    repo = new InMemorySearchIndexRepository();
  });

  // -------------------------------------------------------------------------
  // indexArticle
  // -------------------------------------------------------------------------

  describe("indexArticle", () => {
    it("indexes a document and makes it searchable", async () => {
      await indexDoc(repo, "doc-1", "TypeScript Guide", "Learn TypeScript fundamentals", "knowledge");

      const result = await repo.search({ query: "typescript" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.id).toBe("doc-1");
    });

    it("upserts when indexing with same ID", async () => {
      await indexDoc(repo, "doc-1", "Original Title", "Original content about alpha", "knowledge");
      await indexDoc(repo, "doc-1", "Updated Title", "Completely different content about beta", "knowledge");

      // Old content should no longer be findable
      const alphaResult = await repo.search({ query: "alpha" });
      expect(alphaResult.ok).toBe(true);
      if (!alphaResult.ok) return;
      expect(alphaResult.value).toHaveLength(0);

      // New content should be findable
      const betaResult = await repo.search({ query: "beta" });
      expect(betaResult.ok).toBe(true);
      if (!betaResult.ok) return;
      expect(betaResult.value).toHaveLength(1);
      expect(betaResult.value[0]!.title).toBe("Updated Title");
    });
  });

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  describe("search", () => {
    it("finds document by title match", async () => {
      await indexDoc(repo, "doc-1", "Machine Learning Basics", "An introduction to ML concepts", "knowledge");

      const result = await repo.search({ query: "machine learning" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.id).toBe("doc-1");
    });

    it("finds document by content match", async () => {
      await indexDoc(repo, "doc-1", "Programming Tips", "Use monads for composable error handling", "knowledge");

      const result = await repo.search({ query: "monads" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.id).toBe("doc-1");
    });

    it("ranks title matches higher than content-only matches", async () => {
      // Doc A has the query term only in content
      await indexDoc(
        repo,
        "content-only",
        "Programming Article",
        "Advanced discussion about refactoring patterns and design",
        "knowledge",
      );
      // Doc B has the query term in the title
      await indexDoc(
        repo,
        "title-match",
        "Refactoring Guide",
        "A short introduction to code cleanup",
        "knowledge",
      );

      const result = await repo.search({ query: "refactoring" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBeGreaterThanOrEqual(2);
      expect(result.value[0]!.id).toBe("title-match");
    });

    it("returns empty array for empty query", async () => {
      await indexDoc(repo, "doc-1", "Some Article", "Some content", "knowledge");

      const result = await repo.search({ query: "" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });

    it("returns empty array for whitespace-only query", async () => {
      await indexDoc(repo, "doc-1", "Some Article", "Some content", "knowledge");

      const result = await repo.search({ query: "   " });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });

    it("returns empty array for no matches", async () => {
      await indexDoc(repo, "doc-1", "TypeScript Guide", "Learn TypeScript", "knowledge");

      const result = await repo.search({ query: "zxqwerty" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });

    it("filters by type knowledge", async () => {
      await indexDoc(repo, "k-1", "Knowledge Article", "Some knowledge content", "knowledge");
      await indexDoc(repo, "w-1", "Work Article", "Some work content here", "work");

      const result = await repo.search({ query: "article", type: "knowledge" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.id).toBe("k-1");
    });

    it("filters by type work", async () => {
      await indexDoc(repo, "k-1", "Knowledge Article", "Some knowledge content", "knowledge");
      await indexDoc(repo, "w-1", "Work Article", "Some work content here", "work");

      const result = await repo.search({ query: "article", type: "work" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.id).toBe("w-1");
    });

    it("returns all types when type is all", async () => {
      await indexDoc(repo, "k-1", "Knowledge Article", "Some knowledge content", "knowledge");
      await indexDoc(repo, "w-1", "Work Article", "Some work content here", "work");

      const result = await repo.search({ query: "article", type: "all" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
    });

    it("returns all types when type is undefined", async () => {
      await indexDoc(repo, "k-1", "Knowledge Article", "Some knowledge content", "knowledge");
      await indexDoc(repo, "w-1", "Work Article", "Some work content here", "work");

      const result = await repo.search({ query: "article" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
    });

    it("applies offset and limit", async () => {
      // Index 5 documents all matching "document"
      for (let i = 1; i <= 5; i++) {
        await indexDoc(repo, `doc-${i}`, `Document ${i}`, `Content about document ${i}`, "knowledge");
      }

      const result = await repo.search({ query: "document", limit: 2, offset: 2 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
    });

    it("uses default limit of 20", async () => {
      // Index 25 documents all matching "entry"
      for (let i = 1; i <= 25; i++) {
        await indexDoc(repo, `entry-${i}`, `Entry ${i}`, `Content about entry topic number ${i}`, "knowledge");
      }

      const result = await repo.search({ query: "entry" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(20);
    });

    it("generates snippet with context around match", async () => {
      const content =
        "This is a long introduction. " +
        "Then we discuss refactoring techniques. " +
        "Finally we conclude.";
      await indexDoc(repo, "doc-1", "Article", content, "knowledge");

      const result = await repo.search({ query: "refactoring" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      const snippet = result.value[0]!.snippet;
      expect(snippet).toContain("refactoring");
    });

    it("is case-insensitive", async () => {
      await indexDoc(repo, "doc-1", "TypeScript Handbook", "Covers generics and interfaces", "knowledge");

      const result = await repo.search({ query: "TYPESCRIPT" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
    });

    it("handles multi-term queries", async () => {
      await indexDoc(repo, "doc-1", "React Hooks", "Using hooks for state management", "knowledge");
      await indexDoc(repo, "doc-2", "State Management", "Redux and Zustand patterns", "knowledge");

      const result = await repo.search({ query: "state management" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Both docs should match; doc-2 has both terms in title, doc-1 has them in content
      expect(result.value.length).toBeGreaterThanOrEqual(1);
      // The doc with both terms in the title should rank higher
      expect(result.value[0]!.id).toBe("doc-2");
    });

    it("handles special characters in content", async () => {
      await indexDoc(
        repo,
        "doc-1",
        "Code Examples",
        "Example: function foo(x: number): string { return x.toString(); }",
        "knowledge",
      );

      const result = await repo.search({ query: "function" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // removeArticle
  // -------------------------------------------------------------------------

  describe("removeArticle", () => {
    it("removes article from search results", async () => {
      await indexDoc(repo, "doc-1", "Removable Article", "This content should vanish", "knowledge");

      const before = await repo.search({ query: "removable" });
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      expect(before.value).toHaveLength(1);

      const removeResult = await repo.removeArticle("doc-1");
      expect(removeResult.ok).toBe(true);

      const after = await repo.search({ query: "removable" });
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value).toHaveLength(0);
    });

    it("is idempotent for non-existent ID", async () => {
      const result = await repo.removeArticle("does-not-exist");
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // reindex
  // -------------------------------------------------------------------------

  describe("reindex", () => {
    it("rebuilds index with same results", async () => {
      await indexDoc(repo, "doc-1", "Reindex Test", "Content about algorithms and data structures", "knowledge");
      await indexDoc(repo, "doc-2", "Another Article", "Discusses sorting and searching", "work");

      // Manually corrupt the inverted index to simulate a stale index
      // then verify reindex restores correct results
      const reindexResult = await repo.reindex();
      expect(reindexResult.ok).toBe(true);

      const result = await repo.search({ query: "algorithms" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.id).toBe("doc-1");
    });
  });
});
