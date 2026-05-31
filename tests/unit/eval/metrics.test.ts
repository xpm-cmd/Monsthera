import { describe, it, expect } from "vitest";
import {
  precisionAtK,
  recallAtK,
  ndcgAtK,
  reciprocalRank,
  mean,
  round,
} from "../../../src/eval/metrics.js";

const RANKED = ["a", "b", "c", "d", "e"];

describe("precisionAtK", () => {
  it("counts relevant hits within the top-k window", () => {
    expect(precisionAtK(RANKED, new Set(["a", "c"]), 5)).toBe(0.4);
    expect(precisionAtK(RANKED, new Set(["a", "c"]), 2)).toBe(0.5);
  });
  it("is 0 for an empty window or empty relevant set", () => {
    expect(precisionAtK(RANKED, new Set(["a"]), 0)).toBe(0);
    expect(precisionAtK([], new Set(["a"]), 5)).toBe(0);
    expect(precisionAtK(RANKED, new Set(), 5)).toBe(0);
  });
});

describe("recallAtK", () => {
  it("divides hits by the total relevant set", () => {
    expect(recallAtK(RANKED, new Set(["a", "c", "x"]), 5)).toBeCloseTo(2 / 3, 6);
    expect(recallAtK(RANKED, new Set(["a", "c"]), 5)).toBe(1);
  });
  it("is 0 when there are no relevant items", () => {
    expect(recallAtK(RANKED, new Set(), 5)).toBe(0);
  });
});

describe("ndcgAtK", () => {
  it("discounts by position and normalizes against the ideal ordering", () => {
    // DCG = 1/log2(2) + 1/log2(4) = 1.5 ; IDCG = 1/log2(2) + 1/log2(3) = 1.63093
    expect(ndcgAtK(["a", "b", "c"], new Set(["a", "c"]), 3)).toBeCloseTo(0.9197, 4);
  });
  it("is 1.0 when relevant items occupy the top ranks", () => {
    expect(ndcgAtK(["a", "c", "b"], new Set(["a", "c"]), 3)).toBeCloseTo(1, 6);
  });
  it("is 0 with no relevant items", () => {
    expect(ndcgAtK(RANKED, new Set(), 5)).toBe(0);
  });
});

describe("reciprocalRank", () => {
  it("is the reciprocal of the first relevant rank (1-indexed)", () => {
    expect(reciprocalRank(["b", "a", "c"], new Set(["a"]))).toBe(0.5);
    expect(reciprocalRank(["a", "b"], new Set(["a"]))).toBe(1);
  });
  it("is 0 when nothing relevant is ranked", () => {
    expect(reciprocalRank(["x", "y"], new Set(["a"]))).toBe(0);
  });
});

describe("mean / round", () => {
  it("averages a list and returns 0 for empty", () => {
    expect(mean([0, 1, 0.5])).toBe(0.5);
    expect(mean([])).toBe(0);
  });
  it("rounds to the requested precision", () => {
    expect(round(0.123456)).toBe(0.1235);
    expect(round(0.66666666, 2)).toBe(0.67);
  });
});
