import { describe, it, expect } from "vitest";
import { extractInlineArticleIds } from "../../../src/structure/wikilink.js";

describe("extractInlineArticleIds", () => {
  it("returns [] for empty content", () => {
    expect(extractInlineArticleIds("")).toEqual([]);
  });

  it("returns [] when content has no IDs", () => {
    expect(extractInlineArticleIds("Just prose without citations.")).toEqual([]);
  });

  it("extracts a single short ID", () => {
    expect(extractInlineArticleIds("See k-abc123 for details.")).toEqual(["k-abc123"]);
  });

  it("extracts a hyphenated authored ID", () => {
    expect(
      extractInlineArticleIds("Refer to k-policy-example-security."),
    ).toEqual(["k-policy-example-security"]);
  });

  it("extracts both knowledge and work prefixes", () => {
    const content = "See k-foo and w-bar in the registry.";
    expect(extractInlineArticleIds(content)).toEqual(["k-foo", "w-bar"]);
  });

  it("deduplicates multiple mentions of the same ID", () => {
    const content = "k-foo is defined here. Later, k-foo appears again.";
    expect(extractInlineArticleIds(content)).toEqual(["k-foo"]);
  });

  it("preserves document order on the first occurrence", () => {
    const content = "We cite w-bar, then k-foo, then w-bar again.";
    expect(extractInlineArticleIds(content)).toEqual(["w-bar", "k-foo"]);
  });

  it("ignores IDs inside fenced code blocks", () => {
    const content = [
      "See k-real-id in prose.",
      "```typescript",
      "const example = 'k-fake-id' // an example",
      "```",
      "And also w-prose-id here.",
    ].join("\n");
    expect(extractInlineArticleIds(content)).toEqual(["k-real-id", "w-prose-id"]);
  });

  it("ignores IDs inside inline code spans", () => {
    const content = "Real: k-real-id; docs-only: `k-example` should not count.";
    expect(extractInlineArticleIds(content)).toEqual(["k-real-id"]);
  });

  it("ignores IDs inside HTML comments", () => {
    const content = "<!-- draft: k-todo -->\nProduction: k-live.";
    expect(extractInlineArticleIds(content)).toEqual(["k-live"]);
  });

  it("does not match mid-word patterns (block-link)", () => {
    expect(extractInlineArticleIds("block-link and slack-channel.")).toEqual([]);
  });

  it("does not match standalone letters or prefixes alone", () => {
    expect(extractInlineArticleIds("k and w are letters.")).toEqual([]);
    expect(extractInlineArticleIds("starting k- with hyphen alone.")).toEqual([]);
  });

  it("returns a readonly-friendly array (caller can iterate + spread)", () => {
    const out = extractInlineArticleIds("k-a and w-b");
    expect([...out]).toEqual(["k-a", "w-b"]);
  });
});
