import { describe, it, expect, beforeEach } from "vitest";
import { SearchService } from "../../../src/search/service.js";
import { InMemorySearchIndexRepository } from "../../../src/search/in-memory-repository.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { StubEmbeddingProvider } from "../../../src/search/embedding.js";
import { createLogger } from "../../../src/core/logger.js";
import type { RuntimeStateStore, RuntimeStateSnapshot } from "../../../src/core/runtime-state.js";

/**
 * C3 (ADR-020 deferred follow-up) — custom frontmatter as search terms.
 *
 * `--filter custom.<k><op><v>` could already FILTER by custom frontmatter,
 * but the values never reached the search index: `search("replicability")`
 * could not find an article carrying `replicability_score: 0.85`. Scalar
 * entries (string/number/boolean) are now emitted into the indexed text;
 * nested arrays/objects are deliberately skipped (their flattened tokens
 * would be noise with no field anchor).
 */

let service: SearchService;
let knowledgeRepo: InMemoryKnowledgeArticleRepository;

beforeEach(() => {
  knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const workRepo = new InMemoryWorkArticleRepository();
  const searchRepo = new InMemorySearchIndexRepository();
  const runtimeState: RuntimeStateStore & { snapshot: RuntimeStateSnapshot } = {
    snapshot: {},
    async read() {
      return this.snapshot;
    },
    async write(patch) {
      this.snapshot = { ...this.snapshot, ...patch };
      return this.snapshot;
    },
  };

  service = new SearchService({
    searchRepo,
    knowledgeRepo,
    workRepo,
    embeddingProvider: new StubEmbeddingProvider(),
    config: {
      semanticEnabled: false,
      embeddingModel: "stub",
      embeddingProvider: "ollama" as const,
      alpha: 0.5,
      ollamaUrl: "http://localhost:11434",
    },
    logger: createLogger({ level: "error", domain: "test" }),
    runtimeState,
  });
});

async function seedWithCf(extraFrontmatter?: Record<string, unknown>): Promise<string> {
  const created = await knowledgeRepo.create({
    title: "Lean formalization of max-flow",
    category: "research",
    content: "Body about formalizing the max-flow min-cut theorem.",
    ...(extraFrontmatter ? { extraFrontmatter } : {}),
  });
  if (!created.ok) throw new Error("seed failed");
  const indexed = await service.indexKnowledgeArticle(created.value.id);
  if (!indexed.ok) throw new Error("index failed");
  return created.value.id;
}

describe("custom frontmatter scalars as search terms (C3)", () => {
  it("a scalar cf KEY is searchable (snake_case tokenizes into terms)", async () => {
    const id = await seedWithCf({ replicability_score: 0.85 });

    const result = await service.search({ query: "replicability", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((r) => r.id)).toContain(id);
  });

  it("a scalar cf string VALUE is searchable", async () => {
    const id = await seedWithCf({ origin: "humancurated" });

    const result = await service.search({ query: "humancurated", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((r) => r.id)).toContain(id);
  });

  it("non-scalar cf entries (arrays/objects) are NOT emitted", async () => {
    await seedWithCf({ verification_steps: ["omegaproof", "betacheck"] });

    const byValue = await service.search({ query: "omegaproof", limit: 5 });
    expect(byValue.ok).toBe(true);
    if (!byValue.ok) return;
    expect(byValue.value).toHaveLength(0);

    const byKey = await service.search({ query: "verification", limit: 5 });
    expect(byKey.ok).toBe(true);
    if (!byKey.ok) return;
    expect(byKey.value).toHaveLength(0);
  });

  it("roundtrip: removing a cf entry on update drops its terms after re-index", async () => {
    const id = await seedWithCf({ replicability_score: 0.85 });

    const updated = await knowledgeRepo.update(id, { extraFrontmatter: { origin: "humancurated" } });
    expect(updated.ok).toBe(true);
    const reindexed = await service.indexKnowledgeArticle(id);
    expect(reindexed.ok).toBe(true);

    const stale = await service.search({ query: "replicability", limit: 5 });
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    expect(stale.value).toHaveLength(0);

    const fresh = await service.search({ query: "humancurated", limit: 5 });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.map((r) => r.id)).toContain(id);
  });
});
