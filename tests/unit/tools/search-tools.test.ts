import { describe, it, expect, beforeEach } from "vitest";
import { searchToolDefinitions, handleSearchTool } from "../../../src/tools/search-tools.js";
import { SearchService } from "../../../src/search/service.js";
import { InMemorySearchIndexRepository } from "../../../src/search/in-memory-repository.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { StubEmbeddingProvider } from "../../../src/search/embedding.js";
import { createLogger } from "../../../src/core/logger.js";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

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
  service = new SearchService({
    searchRepo,
    knowledgeRepo,
    workRepo,
    embeddingProvider,
    config,
    logger,
  });
});

async function seedAndIndex() {
  const createResult = await knowledgeRepo.create({
    title: "Auth Guide",
    category: "guide",
    content: "How to authenticate",
  });
  if (!createResult.ok) throw new Error("seed failed");
  const article = createResult.value;
  await service.indexKnowledgeArticle(article.id);
  return article;
}

// ---------------------------------------------------------------------------
// searchToolDefinitions
// ---------------------------------------------------------------------------

describe("searchToolDefinitions", () => {
  it("returns 4 tool definitions", () => {
    const defs = searchToolDefinitions();
    expect(defs).toHaveLength(4);
  });

  it("includes search, index_article, remove_from_index, reindex_all", () => {
    const names = searchToolDefinitions().map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "search",
        "index_article",
        "remove_from_index",
        "reindex_all",
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// handleSearchTool — search
// ---------------------------------------------------------------------------

describe("handleSearchTool", () => {
  describe("search", () => {
    it("returns results for valid query", async () => {
      await seedAndIndex();
      const response = await handleSearchTool("search", { query: "authenticate" }, service);
      expect(response.isError).toBeUndefined();
      const results = JSON.parse(response.content[0]!.text) as unknown[];
      expect(results.length).toBeGreaterThan(0);
    });

    it("returns error for missing query", async () => {
      const response = await handleSearchTool("search", {}, service);
      expect(response.isError).toBe(true);
      const body = JSON.parse(response.content[0]!.text) as { error: string };
      expect(body.error).toBe("VALIDATION_FAILED");
    });
  });

  // -------------------------------------------------------------------------
  // index_article
  // -------------------------------------------------------------------------

  describe("index_article", () => {
    it("indexes article with valid id and source", async () => {
      const createResult = await knowledgeRepo.create({
        title: "Indexable Guide",
        category: "guide",
        content: "Some content to index",
      });
      if (!createResult.ok) throw new Error("seed failed");

      const response = await handleSearchTool(
        "index_article",
        { id: createResult.value.id, source: "knowledge" },
        service,
      );
      expect(response.isError).toBeUndefined();
      const body = JSON.parse(response.content[0]!.text) as { indexed: boolean };
      expect(body.indexed).toBe(true);
    });

    it("returns error for missing id", async () => {
      const response = await handleSearchTool(
        "index_article",
        { source: "knowledge" },
        service,
      );
      expect(response.isError).toBe(true);
      const body = JSON.parse(response.content[0]!.text) as { error: string };
      expect(body.error).toBe("VALIDATION_FAILED");
    });

    it("returns error for invalid source", async () => {
      const response = await handleSearchTool(
        "index_article",
        { id: "some-id", source: "invalid" },
        service,
      );
      expect(response.isError).toBe(true);
      const body = JSON.parse(response.content[0]!.text) as { error: string };
      expect(body.error).toBe("VALIDATION_FAILED");
    });
  });

  // -------------------------------------------------------------------------
  // remove_from_index
  // -------------------------------------------------------------------------

  describe("remove_from_index", () => {
    it("removes article successfully", async () => {
      const article = await seedAndIndex();
      const response = await handleSearchTool(
        "remove_from_index",
        { id: article.id },
        service,
      );
      expect(response.isError).toBeUndefined();
      const body = JSON.parse(response.content[0]!.text) as { removed: boolean };
      expect(body.removed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // reindex_all
  // -------------------------------------------------------------------------

  describe("reindex_all", () => {
    it("returns counts on success", async () => {
      await seedAndIndex();
      const response = await handleSearchTool("reindex_all", {}, service);
      expect(response.isError).toBeUndefined();
      const body = JSON.parse(response.content[0]!.text) as {
        knowledgeCount: number;
        workCount: number;
      };
      expect(typeof body.knowledgeCount).toBe("number");
      expect(typeof body.workCount).toBe("number");
    });
  });

  // -------------------------------------------------------------------------
  // unknown tool
  // -------------------------------------------------------------------------

  describe("unknown tool", () => {
    it("returns NOT_FOUND error", async () => {
      const response = await handleSearchTool("does_not_exist", {}, service);
      expect(response.isError).toBe(true);
      const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
      expect(body.error).toBe("NOT_FOUND");
      expect(body.message).toContain("does_not_exist");
    });
  });
});
