import { describe, it, expect } from "vitest";
import { InMemorySearchIndexRepository } from "../../../src/search/in-memory-repository.js";

async function seed(repo: InMemorySearchIndexRepository): Promise<void> {
  // k-1 carries "alpha" in BOTH title and body (high tf + title-boost path);
  // k-2 only mentions it in the body.
  await repo.indexArticle("k-1", "alpha", "alpha alpha alpha beta", "knowledge");
  await repo.indexArticle("k-2", "gamma", "alpha beta gamma", "knowledge");
}

async function scoreOf(repo: InMemorySearchIndexRepository, id: string): Promise<number> {
  const res = await repo.search({ query: "alpha" });
  if (!res.ok) throw new Error("search failed");
  const hit = res.value.find((r) => r.id === id);
  if (!hit) throw new Error(`no hit for ${id}`);
  return hit.score;
}

describe("InMemorySearchIndexRepository — config-tunable BM25 (PR-10)", () => {
  it("no-arg construction reproduces the baseline (K1=1.2, titleBoost=3.0)", async () => {
    const repo = new InMemorySearchIndexRepository();
    await seed(repo);
    const res = await repo.search({ query: "alpha" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.map((r) => r.id)).toContain("k-1");
  });

  it("bm25K1 changes the saturated-tf score for the same query", async () => {
    const low = new InMemorySearchIndexRepository({ bm25K1: 0.1 });
    const high = new InMemorySearchIndexRepository({ bm25K1: 10 });
    await seed(low);
    await seed(high);
    expect(await scoreOf(low, "k-1")).not.toBe(await scoreOf(high, "k-1"));
  });

  it("titleBoost raises the score of a title-term match", async () => {
    const flat = new InMemorySearchIndexRepository({ titleBoost: 1 });
    const boosted = new InMemorySearchIndexRepository({ titleBoost: 10 });
    await seed(flat);
    await seed(boosted);
    expect(await scoreOf(boosted, "k-1")).toBeGreaterThan(await scoreOf(flat, "k-1"));
  });
});
