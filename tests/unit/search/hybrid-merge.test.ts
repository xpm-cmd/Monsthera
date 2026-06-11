import { describe, it, expect, beforeEach } from "vitest";
import { SearchService } from "../../../src/search/service.js";
import { InMemorySearchIndexRepository } from "../../../src/search/in-memory-repository.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import type { RuntimeStateStore, RuntimeStateSnapshot } from "../../../src/core/runtime-state.js";
import { createLogger } from "../../../src/core/logger.js";
import { ok } from "../../../src/core/result.js";
import type { Result } from "../../../src/core/result.js";
import type { MonstheraError } from "../../../src/core/errors.js";
import type { EmbeddingProvider } from "../../../src/search/embedding.js";

/**
 * C1 (2026-06-10 audit follow-up) — hybrid scale mismatch.
 *
 * `mergeResults` used to emit alpha-mixed scores in [0,1] while bm25-only
 * mode emits RAW bm25 magnitudes (~5-15 for good matches). Downstream,
 * `scoreContextPackItem` adds static boosts (quality/freshness/codeRefs)
 * of up to ~+4 that were implicitly calibrated against the raw scale —
 * so with semantic enabled, the boosts crushed the search signal 4:1 and
 * the pack ranked near-query-independently (the "ADR soup" measured at
 * NDCG@10 0.098 vs 0.877 for bm25-only on the golden set).
 *
 * Contract pinned here:
 *  1. hybrid scores keep bm25 magnitude (rescaled by the per-query max),
 *  2. cosine is min-max stretched per query so the semantic term is
 *     discriminative inside the candidate set,
 *  3. end-to-end: a strongly relevant but stale, boost-poor article
 *     outranks a weakly relevant but fresh, boost-rich one.
 */

/** Deterministic 2-D embedding provider keyed by content markers. */
class MarkerEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 2;
  readonly modelName = "fake-2d";

  constructor(private readonly markers: Array<[string, number[]]>) {}

  async embed(text: string): Promise<Result<number[], MonstheraError>> {
    for (const [marker, vec] of this.markers) {
      if (text.includes(marker)) return ok(vec);
    }
    return ok([0, 1]);
  }

  async embedBatch(texts: string[]): Promise<Result<number[][], MonstheraError>> {
    const out: number[][] = [];
    for (const t of texts) {
      const r = await this.embed(t);
      if (r.ok) out.push(r.value);
    }
    return ok(out);
  }

  async healthCheck(): Promise<Result<{ ready: true }, MonstheraError>> {
    return ok({ ready: true });
  }
}

const QUERY = "hybrid relevance probe";

let service: SearchService;
let knowledgeRepo: InMemoryKnowledgeArticleRepository;
let relevantId: string;
let soupId: string;

beforeEach(async () => {
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
  const embeddingProvider = new MarkerEmbeddingProvider([
    [QUERY, [1, 0]], // the query itself
    ["RELEVANT-MARKER", [0.95, 0.3122]], // cos ≈ 0.95 vs query
    ["SOUP-MARKER", [0.5, 0.866]], // cos = 0.5 vs query
  ]);

  service = new SearchService({
    searchRepo,
    knowledgeRepo,
    workRepo,
    embeddingProvider,
    config: {
      semanticEnabled: true,
      embeddingModel: "fake-2d",
      embeddingProvider: "ollama" as const,
      alpha: 0.5,
      ollamaUrl: "http://localhost:11434",
    },
    logger: createLogger({ level: "error", domain: "test" }),
    runtimeState,
  });

  // Strongly relevant for the query terms, but stale and boost-poor:
  // old updatedAt, no codeRefs, plain category.
  const relevant = await knowledgeRepo.create({
    title: "Hybrid relevance probe deep dive",
    category: "context",
    content:
      "RELEVANT-MARKER hybrid relevance probe. The hybrid relevance probe " +
      "explains how the relevance probe ranks hybrid results.",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  });
  if (!relevant.ok) throw new Error("seed failed");
  relevantId = relevant.value.id;

  // Weakly relevant (single shared term), but boost-rich: fresh, high
  // quality signals, code-linked, boosted category in code mode.
  const soup = await knowledgeRepo.create({
    title: "Architecture decision record on probe subsystem governance",
    category: "architecture",
    content:
      "SOUP-MARKER probe. " +
      "Status Accepted. Context: governance of the subsystem requires careful decision tracking. " +
      "Decision: we will track every subsystem decision with rigorous records and references. " +
      "Consequences: better traceability across the platform and clearer ownership boundaries.",
    codeRefs: ["src/a.ts", "src/b.ts", "src/c.ts"],
    tags: ["governance", "subsystem", "decisions"],
    references: ["k-aaaaaaaa", "k-bbbbbbbb"],
  });
  if (!soup.ok) throw new Error("seed failed");
  soupId = soup.value.id;

  // Filler corpus mass: without it IDF is tiny and raw bm25 magnitudes
  // (~2 on a 2-doc corpus) are unrealistically small next to the pack
  // boosts. Real corpora put strong matches at raw bm25 ~5-15.
  for (let i = 0; i < 6; i++) {
    const filler = await knowledgeRepo.create({
      title: `Background note ${i} on unrelated platform telemetry`,
      category: "context",
      content:
        "Telemetry pipelines aggregate counters and gauges across services. " +
        "Operational dashboards track latency budgets and error rates daily.",
    });
    if (!filler.ok) throw new Error("seed failed");
    const idx = await service.indexKnowledgeArticle(filler.value.id);
    if (!idx.ok) throw new Error("indexing failed");
  }

  const idxR = await service.indexKnowledgeArticle(relevantId);
  const idxS = await service.indexKnowledgeArticle(soupId);
  if (!idxR.ok || !idxS.ok) throw new Error("indexing failed");
});

describe("hybrid merge — scale and discrimination (C1)", () => {
  it("hybrid scores keep the bm25 magnitude instead of collapsing to [0,1]", async () => {
    const result = await service.search({ query: QUERY, limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);

    // bm25-only raw scores for this corpus/query are well above 1; the
    // hybrid path must stay on that magnitude so downstream additive
    // boosts keep their calibrated relative weight.
    const top = result.value[0]!;
    expect(top.score).toBeGreaterThan(1);
  });

  it("strongly relevant but stale beats weakly relevant but boost-rich in the code-mode pack", async () => {
    const pack = await service.buildContextPack({ query: QUERY, mode: "code", limit: 5 });
    expect(pack.ok).toBe(true);
    if (!pack.ok) return;

    const ids = pack.value.items.map((i) => i.id);
    expect(ids).toContain(relevantId);
    expect(ids.indexOf(relevantId)).toBeLessThan(ids.indexOf(soupId));
  });
});
