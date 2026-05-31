import { describe, it, expect } from "vitest";
import { ok, err } from "../../../src/core/result.js";
import type { Result } from "../../../src/core/result.js";
import { type MonstheraError, StorageError } from "../../../src/core/errors.js";
import { SearchService } from "../../../src/search/service.js";
import { InMemorySearchIndexRepository } from "../../../src/search/in-memory-repository.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { StubReranker, type Reranker } from "../../../src/search/reranker.js";
import type { EmbeddingProvider } from "../../../src/search/embedding.js";
import { createLogger } from "../../../src/core/logger.js";
import { slug, articleId } from "../../../src/core/types.js";

// Constant embeddings → every doc has identical cosine, so the hybrid order is
// driven purely by BM25 (which is also equal for identical content). That makes
// the reranker the only thing that can change the order — exactly what we test.
class ConstantEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 3;
  readonly modelName = "constant";
  async embed(): Promise<Result<number[], MonstheraError>> {
    return ok([1, 0, 0]);
  }
  async embedBatch(texts: string[]): Promise<Result<number[][], MonstheraError>> {
    return ok(texts.map(() => [1, 0, 0]));
  }
  async healthCheck(): Promise<Result<{ ready: true }, MonstheraError>> {
    return ok({ ready: true });
  }
}

function fakeReranker(scores: Record<string, number>): Reranker {
  return {
    name: "fake",
    async rerank(_q, candidates) {
      return ok(candidates.map((c) => ({ id: c.id, score: scores[c.id] ?? 0.5 })));
    },
    async healthCheck() {
      return ok({ ready: true });
    },
  };
}

function failingReranker(): Reranker {
  return {
    name: "failing",
    async rerank() {
      return err(new StorageError("rerank boom"));
    },
    async healthCheck() {
      return ok({ ready: true });
    },
  };
}

function runtimeState() {
  return {
    snapshot: {} as Record<string, unknown>,
    async read() {
      return this.snapshot;
    },
    async write(patch: Record<string, unknown>) {
      this.snapshot = { ...this.snapshot, ...patch };
      return this.snapshot;
    },
  };
}

const DOCS = [
  { id: "k-a", title: "Doc A" },
  { id: "k-b", title: "Doc B" },
  { id: "k-c", title: "Doc C" },
];

async function searchOrder(rerankEnabled: boolean, reranker?: Reranker): Promise<string[]> {
  const searchRepo = new InMemorySearchIndexRepository();
  const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const workRepo = new InMemoryWorkArticleRepository();
  const config = {
    semanticEnabled: true,
    embeddingModel: "fake",
    embeddingProvider: "ollama" as const,
    alpha: 0.5,
    ollamaUrl: "http://localhost:11434",
    rerankEnabled,
  };
  const service = new SearchService({
    searchRepo,
    knowledgeRepo,
    workRepo,
    embeddingProvider: new ConstantEmbeddingProvider(),
    config,
    logger: createLogger({ level: "error", domain: "test" }),
    runtimeState: runtimeState(),
    reranker,
  });

  for (const doc of DOCS) {
    const created = await knowledgeRepo.create({
      id: articleId(doc.id),
      title: doc.title,
      slug: slug(doc.id),
      category: "concept", // not a trust-boosted category → trust rerank is neutral here
      content: "alpha beta gamma",
    });
    if (created.ok) await service.indexKnowledgeArticle(created.value.id);
  }

  const result = await service.search({ query: "alpha" });
  if (!result.ok) throw new Error("search failed");
  return result.value.map((r) => r.id);
}

describe("SearchService reranker stage (PR-11)", () => {
  it("a stub reranker leaves the order identical to disabled (exact no-op)", async () => {
    const disabled = await searchOrder(false);
    const stub = await searchOrder(true, new StubReranker());
    expect(disabled.length).toBe(3);
    expect(stub).toEqual(disabled);
  });

  it("the cross-encoder relevance reorders the top hits", async () => {
    const reranked = await searchOrder(true, fakeReranker({ "k-b": 1.0, "k-a": 0.1, "k-c": 0.1 }));
    expect(reranked[0]).toBe("k-b");
  });

  it("a failing reranker degrades to the hybrid order without crashing", async () => {
    const disabled = await searchOrder(false);
    const failed = await searchOrder(true, failingReranker());
    expect(failed).toEqual(disabled);
  });
});
