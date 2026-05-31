import { describe, it, expect } from "vitest";
import { deriveContradictionGaps } from "../../../src/search/think-synthesis.js";
import type { ContextPackItem } from "../../../src/search/service.js";
import type { CanonicalValue } from "../../../src/work/policy-loader.js";

// deriveContradictionGaps only reads `id` and `snippet` off each item; the
// rest of ContextPackItem is irrelevant to this pure function.
function item(id: string, snippet: string): ContextPackItem {
  return { id, snippet } as unknown as ContextPackItem;
}

const CV: readonly CanonicalValue[] = [{ name: "throughput", value: "100" }];

describe("deriveContradictionGaps", () => {
  it("returns no gaps when the registry is empty", () => {
    const items = [item("k-a", "throughput is 100"), item("k-b", "throughput is 200")];
    expect(deriveContradictionGaps(items, [], [])).toEqual([]);
  });

  it("returns no gaps for fewer than two sources", () => {
    expect(deriveContradictionGaps([item("k-a", "throughput is 100")], [], CV)).toEqual([]);
  });

  it("emits a contradictory gap when two sources disagree (snippet fallback)", () => {
    const items = [item("k-a", "throughput is 100 rps"), item("k-b", "throughput is 200 rps")];
    const gaps = deriveContradictionGaps(items, [], CV); // empty contents → snippet fallback
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.kind).toBe("contradictory");
    expect([...gaps[0]!.articleIds].sort()).toEqual(["k-a", "k-b"]);
    expect(gaps[0]!.detail).toContain("throughput");
  });

  it("prefers full contents over snippets when provided", () => {
    const items = [item("k-a", "no number here"), item("k-b", "no number here")];
    const gaps = deriveContradictionGaps(items, ["throughput is 100", "throughput is 200"], CV);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.kind).toBe("contradictory");
  });

  it("emits nothing when the sources agree", () => {
    const items = [item("k-a", "throughput is 100"), item("k-b", "throughput is 100 confirmed")];
    expect(deriveContradictionGaps(items, [], CV)).toEqual([]);
  });
});
