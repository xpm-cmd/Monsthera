/* eslint-disable no-console -- diagnostic output for an Ollama-gated integration test */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createContainer } from "../../src/core/container.js";
import { defaultConfig } from "../../src/core/config.js";
import type { SearchService } from "../../src/search/service.js";

// Skip if Ollama is not available (CI environments)
const ollamaAvailable = await fetch("http://localhost:11434/api/tags").then(() => true).catch(() => false);

describe.skipIf(!ollamaAvailable)("semantic search integration", () => {
  let searchService: SearchService;
  let disposeContainer: () => Promise<void>;

  beforeAll(async () => {
    const config = {
      ...defaultConfig(process.cwd()),
      search: {
        semanticEnabled: true,
        embeddingProvider: "ollama" as const,
        embeddingModel: "nomic-embed-text",
        ollamaUrl: "http://localhost:11434",
        alpha: 0.5,
      },
    };
    const container = await createContainer(config);
    searchService = container.searchService;
    disposeContainer = container.dispose;

    // Reindex to build BM25 index + generate embeddings
    const result = await searchService.fullReindex();
    expect(result.ok).toBe(true);
    if (result.ok) {
      console.log(`Reindexed: ${result.value.knowledgeCount} knowledge + ${result.value.workCount} work articles`);
    }
  }, 120_000);

  afterAll(async () => {
    await disposeContainer();
  });

  it("has embeddings after reindex", () => {
    const repo = (searchService as unknown as { searchRepo: { embeddingCount: number } }).searchRepo;
    expect(repo.embeddingCount).toBeGreaterThan(0);
    console.log(`Embedding count: ${repo.embeddingCount}`);
  });

  it("hybrid search returns results for semantic query", async () => {
    const result = await searchService.search({
      query: "dependency injection container service lifecycle",
      limit: 5,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      console.log("\n=== Hybrid search: 'dependency injection container service lifecycle' ===");
      result.value.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.title} (score: ${r.score.toFixed(3)}, type: ${r.type})`);
      });
      expect(result.value.length).toBeGreaterThan(0);
    }
  }, 30_000);

  it("semantic query finds conceptually related results", async () => {
    const result = await searchService.search({
      query: "how agents coordinate and share work between them",
      limit: 5,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      console.log("\n=== Conceptual search: 'how agents coordinate and share work' ===");
      result.value.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.title} (score: ${r.score.toFixed(3)}, type: ${r.type})`);
      });
      expect(result.value.length).toBeGreaterThan(0);
    }
  }, 30_000);
});
