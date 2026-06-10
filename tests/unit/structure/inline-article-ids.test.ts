import { describe, it, expect } from "vitest";
import { extractInlineArticleIds } from "../../../src/structure/wikilink.js";

describe("extractInlineArticleIds", () => {
  // NOTE (Banyan P0-C): fixture ids in this block are digit-bearing in
  // their first segment because the ID-shape candidate rule now drops
  // digit-less prose tokens (`k-foo`, `k-real-id`, …) by design. The ids
  // inside code regions are digit-bearing too, on purpose — if code-region
  // stripping ever regresses, they would leak through the shape filter and
  // fail these tests, preserving the original regression bite.

  it("returns [] for empty content", () => {
    expect(extractInlineArticleIds("")).toEqual([]);
  });

  it("returns [] when content has no IDs", () => {
    expect(extractInlineArticleIds("Just prose without citations.")).toEqual([]);
  });

  it("extracts a single short ID", () => {
    expect(extractInlineArticleIds("See k-abc123 for details.")).toEqual(["k-abc123"]);
  });

  it("extracts a hyphenated authored ID when the stem is digit-bearing", () => {
    // Deliberate behavior change: the old fixture `k-policy-example-security`
    // (digit-less first segment) encoded the k-successor-star FP class and is
    // no longer a candidate; authored ids stay detectable from prose only
    // when their stem carries a digit.
    expect(
      extractInlineArticleIds("Refer to k-91-policy-example-security."),
    ).toEqual(["k-91-policy-example-security"]);
  });

  it("extracts both knowledge and work prefixes", () => {
    const content = "See k-foo1 and w-bar2 in the registry.";
    expect(extractInlineArticleIds(content)).toEqual(["k-foo1", "w-bar2"]);
  });

  it("deduplicates multiple mentions of the same ID", () => {
    const content = "k-foo1 is defined here. Later, k-foo1 appears again.";
    expect(extractInlineArticleIds(content)).toEqual(["k-foo1"]);
  });

  it("preserves document order on the first occurrence", () => {
    const content = "We cite w-bar2, then k-foo1, then w-bar2 again.";
    expect(extractInlineArticleIds(content)).toEqual(["w-bar2", "k-foo1"]);
  });

  it("ignores IDs inside fenced code blocks", () => {
    const content = [
      "See k-a1b2c3d4 in prose.",
      "```typescript",
      "const example = 'k-fake123' // an example",
      "```",
      "And also w-e5f6a7b8 here.",
    ].join("\n");
    expect(extractInlineArticleIds(content)).toEqual(["k-a1b2c3d4", "w-e5f6a7b8"]);
  });

  it("ignores IDs inside inline code spans", () => {
    const content = "Real: k-real1; docs-only: `k-example2` should not count.";
    expect(extractInlineArticleIds(content)).toEqual(["k-real1"]);
  });

  it("ignores IDs inside a soft-wrapped (multi-line) inline code span", () => {
    // convoy-hardening-design-decisions.md regression: a single inline-code
    // span wrapped across a newline (CommonMark joins the line ending to a
    // space) carries example ids w-x1 / w-a2 / w-b3 that must NOT be cited.
    const content = [
      "2. CLI ergonomics. `monsthera convoy create --lead w-x1 --members",
      "   w-a2,w-b3 --goal 'g'` is the muscle-memory shape from S3.",
      "Real follow-up: w-prose9.",
    ].join("\n");
    expect(extractInlineArticleIds(content)).toEqual(["w-prose9"]);
  });

  it("ignores IDs inside HTML comments", () => {
    const content = "<!-- draft: k-todo1 -->\nProduction: k-live2.";
    expect(extractInlineArticleIds(content)).toEqual(["k-live2"]);
  });

  it("does not match mid-word patterns (block-link)", () => {
    expect(extractInlineArticleIds("block-link and slack-channel.")).toEqual([]);
  });

  it("does not match standalone letters or prefixes alone", () => {
    expect(extractInlineArticleIds("k and w are letters.")).toEqual([]);
    expect(extractInlineArticleIds("starting k- with hyphen alone.")).toEqual([]);
  });

  it("returns a readonly-friendly array (caller can iterate + spread)", () => {
    const out = extractInlineArticleIds("k-a1 and w-b2");
    expect([...out]).toEqual(["k-a1", "w-b2"]);
  });
});

describe("extractInlineArticleIds — ID-shape candidate rule (Banyan P0-C)", () => {
  // A bare `k-…`/`w-…` token in prose only counts as a citation CANDIDATE
  // when its FIRST hyphen-segment after the prefix contains a digit.
  // Math/prose terms like "k-successor-star", "k-means", "w-shaped" are NOT
  // citations and must not reach the orphan detector.

  it("does NOT extract digit-less hyphenated prose terms (k-successor-star FP class)", () => {
    const content =
      "The k-successor-star closure uses k-means style updates on the w-shaped curve.";
    expect(extractInlineArticleIds(content)).toEqual([]);
  });

  it("extracts shorthand numeric stems (k-10-01, k-90-03)", () => {
    expect(extractInlineArticleIds("Proof in k-10-01 builds on k-90-03.")).toEqual([
      "k-10-01",
      "k-90-03",
    ]);
  });

  it("extracts mixed-case segmented ids in full (k-91-HB-013)", () => {
    expect(extractInlineArticleIds("Handbook entry k-91-HB-013 covers this.")).toEqual([
      "k-91-HB-013",
    ]);
  });

  it("extracts auto-generated ids (k-3zo9w9dg, w-0ieze72s)", () => {
    expect(extractInlineArticleIds("See k-3zo9w9dg and w-0ieze72s.")).toEqual([
      "k-3zo9w9dg",
      "w-0ieze72s",
    ]);
  });

  it("extracts a first-segment with trailing digits (k-abc123)", () => {
    expect(extractInlineArticleIds("Token k-abc123 keeps flagging.")).toEqual(["k-abc123"]);
  });

  it("extracts a digit-stem id with a trailing word segment (k-99-99-ghost)", () => {
    expect(extractInlineArticleIds("Cites k-99-99-ghost for the control.")).toEqual([
      "k-99-99-ghost",
    ]);
  });

  it("digit in a LATER segment does not rescue a digit-less first segment", () => {
    // First segment "means" has no digit — the 90 in the second segment
    // must not turn the prose term into a candidate.
    expect(extractInlineArticleIds("the k-means-90 variant")).toEqual([]);
  });
});
