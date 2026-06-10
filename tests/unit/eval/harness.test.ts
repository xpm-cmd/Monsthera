import { describe, it, expect } from "vitest";
import { ok, err } from "../../../src/core/result.js";
import { StorageError } from "../../../src/core/errors.js";
import {
  runEval,
  detectEngine,
  type EvalProvider,
  type EvalEmbeddingProbe,
} from "../../../src/eval/harness.js";
import type { GoldenCase } from "../../../src/eval/golden.js";
import type { ContextPack } from "../../../src/search/service.js";
import type { SearchResult } from "../../../src/search/repository.js";

function packOf(ids: string[]): ContextPack {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    query: "q",
    mode: "general",
    summary: {
      itemCount: ids.length,
      knowledgeCount: ids.length,
      workCount: 0,
      freshCount: 0,
      staleCount: 0,
      codeLinkedCount: 0,
      sourceLinkedCount: 0,
      skippedStaleIndexCount: 0,
    },
    guidance: [],
    items: ids.map((id) => ({ id, type: "knowledge" })) as unknown as ContextPack["items"],
  };
}

function resultsOf(ids: string[]): SearchResult[] {
  return ids.map((id) => ({ id, title: id, type: "knowledge" as const, score: 1, snippet: "" }));
}

function fakeProvider(packIds: string[], searchIds: string[]): EvalProvider {
  return {
    async buildContextPack() {
      return ok(packOf(packIds));
    },
    async search() {
      return ok(resultsOf(searchIds));
    },
  };
}

/** Fake embedding probe: `healthy` drives whether `healthCheck()` returns ok/err. */
function fakeProbe(healthy: boolean): EvalEmbeddingProbe {
  return {
    async healthCheck() {
      return healthy ? ok({ ready: true as const }) : err(new StorageError("Ollama not reachable"));
    },
  };
}

const CASE: GoldenCase = { query: "q", expectedArticleIds: ["k-1", "k-2"] };

describe("runEval", () => {
  it("scores the context-pack target from ranked item ids", async () => {
    const provider = fakeProvider(["k-1", "x", "k-2"], []);
    const report = await runEval({ provider, cases: [CASE], target: "pack", k: 3 });

    expect(report.caseCount).toBe(1);
    const c = report.cases[0]!;
    expect(c.rankedTopK).toEqual(["k-1", "x", "k-2"]);
    expect(c.precision).toBeCloseTo(2 / 3, 4); // 2 relevant in top 3
    expect(c.recall).toBe(1); // both relevant found
    expect(c.reciprocalRank).toBe(1); // k-1 is first
    expect(report.aggregate.recallAtK).toBe(1);
  });

  it("scores the search target from ranked result ids", async () => {
    const provider = fakeProvider([], ["z", "k-2"]);
    const report = await runEval({ provider, cases: [CASE], target: "search", k: 5 });

    const c = report.cases[0]!;
    expect(c.rankedTopK).toEqual(["z", "k-2"]);
    expect(c.precision).toBeCloseTo(1 / 2, 4); // 1 relevant in 2 results
    expect(c.reciprocalRank).toBe(0.5); // k-2 at rank 2
  });

  it("records a retrieval error as a zeroed case without aborting", async () => {
    const provider: EvalProvider = {
      async buildContextPack() {
        return err(new StorageError("boom"));
      },
      async search() {
        return err(new StorageError("boom"));
      },
    };
    const report = await runEval({ provider, cases: [CASE], target: "pack", k: 5 });
    const c = report.cases[0]!;
    expect(c.error).toContain("boom");
    expect(c.precision).toBe(0);
    expect(c.ndcg).toBe(0);
  });

  it("produces non-saturated NDCG/precision for a multi-relevant case with imperfect ranking", async () => {
    // 3 relevant ids; ranking places one relevant at rank 1, the other two at
    // ranks 4 and 5 with distractors between — NDCG must drop below 1.0 and
    // P@5 must land at 3/5. This is exactly the discrimination the saturated
    // single-expected golden set could not provide.
    const multi: GoldenCase = { query: "q", expectedArticleIds: ["k-1", "k-2", "k-3"] };
    const provider = fakeProvider(["k-1", "x", "y", "k-2", "k-3"], []);
    const report = await runEval({ provider, cases: [multi], target: "pack", k: 5 });
    const c = report.cases[0]!;

    expect(c.precision).toBeCloseTo(3 / 5, 4); // 3 relevant in top 5
    expect(c.recall).toBe(1); // all three found within k
    // DCG = 1/log2(2) + 1/log2(5) + 1/log2(6); IDCG = top-3 positions.
    const dcg = 1 / Math.log2(2) + 1 / Math.log2(5) + 1 / Math.log2(6);
    const idcg = 1 / Math.log2(2) + 1 / Math.log2(3) + 1 / Math.log2(4);
    expect(c.ndcg).toBeCloseTo(dcg / idcg, 4);
    expect(c.ndcg).toBeLessThan(1); // demonstrably non-saturated
    expect(c.contamination).toBeUndefined(); // no forbidden list declared
  });

  it("counts forbiddenArticleIds contamination in the top-k and aggregates a rate", async () => {
    // Two forbidden distractors; one ("bad-1") leaks into the top-3, the other
    // ("bad-2") does not appear at all → contamination = 1.
    const guarded: GoldenCase = {
      query: "q",
      expectedArticleIds: ["k-1"],
      forbiddenArticleIds: ["bad-1", "bad-2"],
    };
    const provider = fakeProvider(["k-1", "bad-1", "z"], []);
    const report = await runEval({ provider, cases: [guarded], target: "pack", k: 3 });
    const c = report.cases[0]!;

    expect(c.contamination).toBe(1);
    expect(report.aggregate.contaminationRate).toBe(1);
    // Relevance math is untouched by the forbidden list.
    expect(c.precision).toBeCloseTo(1 / 3, 4);
    expect(c.reciprocalRank).toBe(1);
  });

  it("reports a clean zero contamination when a forbidden id is absent", async () => {
    const guarded: GoldenCase = {
      query: "q",
      expectedArticleIds: ["k-1"],
      forbiddenArticleIds: ["bad-1"],
    };
    const provider = fakeProvider(["k-1", "z"], []);
    const report = await runEval({ provider, cases: [guarded], target: "pack", k: 5 });

    expect(report.cases[0]!.contamination).toBe(0);
    expect(report.aggregate.contaminationRate).toBe(0);
  });

  it("omits per-case contamination and zeroes the rate when no case declares forbidden ids", async () => {
    const provider = fakeProvider(["k-1", "k-2"], []);
    const report = await runEval({ provider, cases: [CASE], target: "pack", k: 5 });

    expect(report.cases[0]!.contamination).toBeUndefined();
    expect(report.aggregate.contaminationRate).toBe(0); // mean of empty list
  });

  it("stamps the supplied engine onto the report", async () => {
    const provider = fakeProvider(["k-1", "k-2"], []);
    const report = await runEval({
      provider,
      cases: [CASE],
      target: "pack",
      k: 5,
      engine: "bm25-fallback",
    });
    expect(report.engine).toBe("bm25-fallback");
  });

  it("defaults engine to 'unknown' when none is supplied (back-compat)", async () => {
    const provider = fakeProvider(["k-1", "k-2"], []);
    const report = await runEval({ provider, cases: [CASE], target: "pack", k: 5 });
    expect(report.engine).toBe("unknown");
  });
});

describe("detectEngine", () => {
  it("reports 'bm25-disabled' without probing when semantic is off", async () => {
    let probed = false;
    const probe: EvalEmbeddingProbe = {
      async healthCheck() {
        probed = true;
        return ok({ ready: true as const });
      },
    };
    const engine = await detectEngine(probe, false);
    expect(engine).toBe("bm25-disabled");
    expect(probed).toBe(false); // no live call when disabled
  });

  it("reports 'semantic' when enabled and the provider healthCheck passes", async () => {
    const engine = await detectEngine(fakeProbe(true), true);
    expect(engine).toBe("semantic");
  });

  it("reports 'bm25-fallback' when enabled but the provider healthCheck fails", async () => {
    // This is the 2026-06-10 audit scenario: semantic configured on, Ollama
    // down → every query fell back to BM25. The engine label must say so
    // instead of the old static 'semantic=on'.
    const engine = await detectEngine(fakeProbe(false), true);
    expect(engine).toBe("bm25-fallback");
  });
});
