import { describe, expect, it } from "vitest";
import { normalizeTag, normalizeTags, applyTagDelta } from "../../../src/knowledge/tags.js";

describe("normalizeTag", () => {
  it("strips a single surrounding quote pair", () => {
    expect(normalizeTag("'family:kriging'")).toBe("family:kriging");
    expect(normalizeTag('"family:kriging"')).toBe("family:kriging");
  });

  it("trims and collapses internal whitespace runs", () => {
    expect(normalizeTag("  machine   learning ")).toBe("machine learning");
  });

  it("leaves an already-clean tag unchanged", () => {
    expect(normalizeTag("family:kriging")).toBe("family:kriging");
  });

  it("returns empty string for empty / quote-only input", () => {
    expect(normalizeTag("''")).toBe("");
    expect(normalizeTag("   ")).toBe("");
  });
});

describe("normalizeTags", () => {
  it("dedupes quote/whitespace variants that collapse to one value", () => {
    expect(
      normalizeTags(["'family:kriging'", "family:kriging", " family:kriging "]),
    ).toEqual(["family:kriging"]);
  });

  it("dedupes case-variants, preserving the first-seen casing", () => {
    expect(normalizeTags(["Kriging", "kriging"])).toEqual(["Kriging"]);
  });

  it("drops empties and preserves first-seen order", () => {
    expect(normalizeTags(["", "beta", "alpha", "beta"])).toEqual(["beta", "alpha"]);
  });
});

describe("applyTagDelta", () => {
  it("adds new tags, preserving existing first-seen order", () => {
    expect(applyTagDelta(["alpha", "beta"], ["gamma"], [])).toEqual(["alpha", "beta", "gamma"]);
  });

  it("removes a tag", () => {
    expect(applyTagDelta(["alpha", "beta", "gamma"], [], ["beta"])).toEqual(["alpha", "gamma"]);
  });

  it("adds and removes in one call", () => {
    expect(applyTagDelta(["alpha", "beta"], ["gamma"], ["alpha"])).toEqual(["beta", "gamma"]);
  });

  it("removing a non-existent tag is a no-op", () => {
    expect(applyTagDelta(["alpha"], [], ["zeta"])).toEqual(["alpha"]);
  });

  it("removal matches on the normalized key (case- and quote-insensitive)", () => {
    expect(applyTagDelta(["Kriging"], [], ["'kriging'"])).toEqual([]);
  });

  it("normalizes and dedupes added tags against existing ones", () => {
    expect(applyTagDelta(["alpha"], ["'Alpha'", "  beta "], [])).toEqual(["alpha", "beta"]);
  });
});
