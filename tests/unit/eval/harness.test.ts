import { describe, it, expect } from "vitest";
import { ok, err } from "../../../src/core/result.js";
import { StorageError } from "../../../src/core/errors.js";
import { runEval, type EvalProvider } from "../../../src/eval/harness.js";
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
});
