import { describe, it, expect, beforeEach } from "vitest";
import { SearchService } from "../../../src/search/service.js";
import { InMemorySearchIndexRepository } from "../../../src/search/in-memory-repository.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { StubEmbeddingProvider } from "../../../src/search/embedding.js";
import { createLogger } from "../../../src/core/logger.js";

// ─── Setup ────────────────────────────────────────────────────────────────────

let service: SearchService;
let knowledgeRepo: InMemoryKnowledgeArticleRepository;
let workRepo: InMemoryWorkArticleRepository;

beforeEach(() => {
  const searchRepo = new InMemorySearchIndexRepository();
  knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  workRepo = new InMemoryWorkArticleRepository();
  const embeddingProvider = new StubEmbeddingProvider();
  const logger = createLogger({ level: "warn", domain: "test" });
  const config = {
    semanticEnabled: false,
    embeddingModel: "stub",
    embeddingProvider: "ollama" as const,
    alpha: 0.5,
    ollamaUrl: "http://localhost:11434",
  };

  service = new SearchService({ searchRepo, knowledgeRepo, workRepo, embeddingProvider, config, logger });
});

// ─── Fixture helpers ──────────────────────────────────────────────────────────

async function seedKnowledgeArticle(overrides?: Record<string, unknown>) {
  const input = {
    title: "Test Article",
    category: "concept",
    content: "Some content about testing",
    ...overrides,
  };
  const result = await knowledgeRepo.create(input as Parameters<typeof knowledgeRepo.create>[0]);
  if (!result.ok) throw new Error("Failed to seed knowledge article");
  return result.value;
}

async function seedWorkArticle(overrides?: Record<string, unknown>) {
  const input = {
    title: "Fix Bug",
    template: "bugfix" as const,
    priority: "medium" as const,
    author: "agent-1",
    content: "Fix the broken thing",
    ...overrides,
  };
  const result = await workRepo.create(input as Parameters<typeof workRepo.create>[0]);
  if (!result.ok) throw new Error("Failed to seed work article");
  return result.value;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SearchService", () => {
  describe("search", () => {
    it("returns results for valid query", async () => {
      const article = await seedKnowledgeArticle({ title: "TypeScript Guide", content: "Learn TypeScript basics" });
      await service.indexKnowledgeArticle(article.id);

      const result = await service.search({ query: "TypeScript" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBeGreaterThan(0);
      expect(result.value[0]!.title).toBe("TypeScript Guide");
    });

    it("returns ValidationError for empty query", async () => {
      const result = await service.search({ query: "" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("VALIDATION_FAILED");
    });

    it("returns empty array when nothing matches", async () => {
      await seedKnowledgeArticle({ title: "Python Guide", content: "Learn Python" });

      const result = await service.search({ query: "Rust" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // No articles indexed, so no results
      expect(result.value).toEqual([]);
    });

    it("filters by type", async () => {
      const kArticle = await seedKnowledgeArticle({ title: "Knowledge Doc", content: "knowledge content" });
      const wArticle = await seedWorkArticle({ title: "Work Item", content: "work content" });
      await service.indexKnowledgeArticle(kArticle.id);
      await service.indexWorkArticle(wArticle.id);

      const result = await service.search({ query: "content", type: "knowledge" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.every((r) => r.type === "knowledge")).toBe(true);
    });

    it("applies pagination", async () => {
      // Seed and index multiple articles with similar content
      for (let i = 0; i < 5; i++) {
        const article = await seedKnowledgeArticle({
          title: `Article ${i}`,
          content: `pagination test content item ${i}`,
        });
        await service.indexKnowledgeArticle(article.id);
      }

      const limitResult = await service.search({ query: "pagination", limit: 2 });
      expect(limitResult.ok).toBe(true);
      if (!limitResult.ok) return;
      expect(limitResult.value.length).toBeLessThanOrEqual(2);

      const offsetResult = await service.search({ query: "pagination", limit: 10, offset: 3 });
      expect(offsetResult.ok).toBe(true);
      if (!offsetResult.ok) return;
      expect(offsetResult.value.length).toBeLessThanOrEqual(2);
    });
  });

  describe("indexKnowledgeArticle", () => {
    it("indexes and makes article searchable", async () => {
      const article = await seedKnowledgeArticle({ title: "Indexable Article", content: "unique searchable phrase" });
      const indexResult = await service.indexKnowledgeArticle(article.id);
      expect(indexResult.ok).toBe(true);

      const searchResult = await service.search({ query: "unique searchable phrase" });
      expect(searchResult.ok).toBe(true);
      if (!searchResult.ok) return;
      expect(searchResult.value.some((r) => r.id === article.id)).toBe(true);
    });

    it("includes codeRefs in indexed content", async () => {
      const article = await seedKnowledgeArticle({
        title: "Ref Article",
        content: "Some content",
        codeRefs: ["src/core/container.ts"],
      });
      await service.indexKnowledgeArticle(article.id);

      const result = await service.search({ query: "container" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.some((r) => r.id === article.id)).toBe(true);
    });

    it("returns NotFoundError for non-existent article", async () => {
      const result = await service.indexKnowledgeArticle("nonexistent-id");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });
  });

  describe("indexWorkArticle", () => {
    it("indexes and makes work article searchable", async () => {
      const article = await seedWorkArticle({ title: "Searchable Work", content: "work content to find" });
      const indexResult = await service.indexWorkArticle(article.id);
      expect(indexResult.ok).toBe(true);

      const searchResult = await service.search({ query: "work content to find" });
      expect(searchResult.ok).toBe(true);
      if (!searchResult.ok) return;
      expect(searchResult.value.some((r) => r.id === article.id)).toBe(true);
    });

    it("returns NotFoundError for non-existent article", async () => {
      const result = await service.indexWorkArticle("nonexistent-id");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("NOT_FOUND");
    });
  });

  describe("removeArticle", () => {
    it("removes article from search results", async () => {
      const article = await seedKnowledgeArticle({ title: "To Be Removed", content: "removable content" });
      await service.indexKnowledgeArticle(article.id);

      // Verify it's findable
      const beforeResult = await service.search({ query: "removable content" });
      expect(beforeResult.ok).toBe(true);
      if (!beforeResult.ok) return;
      expect(beforeResult.value.some((r) => r.id === article.id)).toBe(true);

      // Remove it
      const removeResult = await service.removeArticle(article.id);
      expect(removeResult.ok).toBe(true);

      // Verify it's gone
      const afterResult = await service.search({ query: "removable content" });
      expect(afterResult.ok).toBe(true);
      if (!afterResult.ok) return;
      expect(afterResult.value.some((r) => r.id === article.id)).toBe(false);
    });
  });

  describe("fullReindex", () => {
    it("indexes all articles from both repos", async () => {
      const kArticle = await seedKnowledgeArticle({ title: "Knowledge Item", content: "knowledge reindex" });
      const wArticle = await seedWorkArticle({ title: "Work Item", content: "work reindex" });

      const reindexResult = await service.fullReindex();
      expect(reindexResult.ok).toBe(true);

      const kSearch = await service.search({ query: "knowledge reindex" });
      expect(kSearch.ok).toBe(true);
      if (!kSearch.ok) return;
      expect(kSearch.value.some((r) => r.id === kArticle.id)).toBe(true);

      const wSearch = await service.search({ query: "work reindex" });
      expect(wSearch.ok).toBe(true);
      if (!wSearch.ok) return;
      expect(wSearch.value.some((r) => r.id === wArticle.id)).toBe(true);
    });

    it("returns counts", async () => {
      await seedKnowledgeArticle({ title: "K1", content: "content" });
      await seedKnowledgeArticle({ title: "K2", content: "content" });
      await seedWorkArticle({ title: "W1", content: "content" });

      const result = await service.fullReindex();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.knowledgeCount).toBe(2);
      expect(result.value.workCount).toBe(1);
    });

    it("does not remove stale entries — use removeArticle explicitly", async () => {
      const article = await seedKnowledgeArticle({ title: "Orphan Article", content: "orphan content" });
      await service.indexKnowledgeArticle(article.id);

      // Delete from source repo (leaving stale index entry)
      await knowledgeRepo.delete(article.id);

      // fullReindex upserts current source articles but does NOT purge orphans
      await service.fullReindex();

      const after = await service.search({ query: "orphan content" });
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      // Stale entry still present — explicit removeArticle is required
      expect(after.value.some((r) => r.id === article.id)).toBe(true);

      // Explicit removal cleans it up
      await service.removeArticle(article.id);
      const final = await service.search({ query: "orphan content" });
      expect(final.ok).toBe(true);
      if (!final.ok) return;
      expect(final.value.some((r) => r.id === article.id)).toBe(false);
    });
  });
});
