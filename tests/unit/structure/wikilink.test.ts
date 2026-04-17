import { describe, it, expect } from "vitest";
import { extractWikilinks, parseWikilink } from "../../../src/structure/wikilink.js";

describe("parseWikilink", () => {
  it("parses a plain slug", () => {
    expect(parseWikilink("foo")).toEqual({ slug: "foo", display: null, anchor: null });
  });
  it("strips display text after pipe", () => {
    expect(parseWikilink("foo|bar")).toEqual({ slug: "foo", display: "bar", anchor: null });
  });
  it("strips anchor after hash", () => {
    expect(parseWikilink("foo#section")).toEqual({ slug: "foo", display: null, anchor: "section" });
  });
  it("strips both anchor and display", () => {
    expect(parseWikilink("foo#section|Display Text")).toEqual({ slug: "foo", display: "Display Text", anchor: "section" });
  });
  it("trims inner whitespace", () => {
    expect(parseWikilink("  foo  |  bar  ")).toEqual({ slug: "foo", display: "bar", anchor: null });
  });
  it("keeps Obsidian subpath slugs intact", () => {
    expect(parseWikilink("foo/sub")).toEqual({ slug: "foo/sub", display: null, anchor: null });
  });
});

describe("extractWikilinks", () => {
  it("extracts multiple links from prose", () => {
    const content = "See [[foo|F]] and [[bar]] and [[baz#x]].";
    expect(extractWikilinks(content)).toEqual([
      { slug: "foo", display: "F", anchor: null },
      { slug: "bar", display: null, anchor: null },
      { slug: "baz", display: null, anchor: "x" },
    ]);
  });
  it("keeps duplicates with different display text (dedup happens upstream)", () => {
    const content = "[[foo|A]] and later [[foo|B]] and [[foo]]";
    const links = extractWikilinks(content);
    expect(links).toHaveLength(3);
    expect(links.map((l) => l.slug)).toEqual(["foo", "foo", "foo"]);
    expect(links.map((l) => l.display)).toEqual(["A", "B", null]);
  });
  it("returns empty array when no wikilinks", () => {
    expect(extractWikilinks("plain prose no links")).toEqual([]);
  });
  it("Aloea regression — pipe-syntax slugs resolve correctly", () => {
    // These are actual false-positive entries from the Aloea wiki baseline
    const content = `This is graded [[evidence-levels-and-traceability|L1]] per CPIC.
See [[longitudinal-tracking-vs-snapshot|trajectory]] and [[aloea-project-overview|Aloea]].`;
    const slugs = extractWikilinks(content).map((l) => l.slug);
    expect(slugs).toEqual([
      "evidence-levels-and-traceability",
      "longitudinal-tracking-vs-snapshot",
      "aloea-project-overview",
    ]);
  });
});
