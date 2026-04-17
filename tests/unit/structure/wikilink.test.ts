import { describe, it, expect } from "vitest";
import { extractWikilinks, parseWikilink, stripCodeRegions } from "../../../src/structure/wikilink.js";

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

describe("stripCodeRegions", () => {
  it("removes fenced code blocks with backticks", () => {
    const input = "before\n```\n[[foo]]\n```\nafter";
    const out = stripCodeRegions(input);
    expect(out).not.toContain("[[foo]]");
    expect(out).toContain("before");
    expect(out).toContain("after");
  });
  it("removes fenced code blocks with tildes", () => {
    const input = "prose\n~~~\n[[bar]]\n~~~\nmore prose";
    const out = stripCodeRegions(input);
    expect(out).not.toContain("[[bar]]");
  });
  it("removes fenced blocks with language tag", () => {
    const input = "text\n```ts\nconst x = [[baz]];\n```\nmore";
    expect(stripCodeRegions(input)).not.toContain("[[baz]]");
  });
  it("removes inline code with single backticks", () => {
    const input = "see `[[qux]]` here";
    expect(stripCodeRegions(input)).not.toContain("[[qux]]");
  });
  it("removes inline code with double backticks containing a backtick", () => {
    const input = "span ``code with ` backtick and [[nope]]`` done";
    expect(stripCodeRegions(input)).not.toContain("[[nope]]");
  });
  it("removes HTML comments", () => {
    const input = "<!-- [[hidden]] -->visible [[shown]]";
    const out = stripCodeRegions(input);
    expect(out).not.toContain("[[hidden]]");
    expect(out).toContain("[[shown]]");
  });
  it("removes multiline HTML comments", () => {
    const input = "before\n<!--\n  [[wrapped]]\n-->\nafter [[kept]]";
    const out = stripCodeRegions(input);
    expect(out).not.toContain("[[wrapped]]");
    expect(out).toContain("[[kept]]");
  });
  it("preserves wikilinks in plain prose", () => {
    const input = "Read [[article-a]] then [[article-b]] for context.";
    const out = stripCodeRegions(input);
    expect(out).toContain("[[article-a]]");
    expect(out).toContain("[[article-b]]");
  });
});

describe("extractWikilinks with code regions", () => {
  it("Aloea regression — protocol article with fenced placeholder block", () => {
    // Faithful reproduction of k-1g2dab9h content shape
    const content = `# Protocol

Articles follow this format:

\`\`\`
- [[slug]] — one-line summary
- [[slug1]] and [[slug2]] paired
\`\`\`

Real link: [[aloea-project-overview]]`;
    const slugs = extractWikilinks(content).map((l) => l.slug);
    expect(slugs).toEqual(["aloea-project-overview"]);
  });
  it("Aloea regression — log article with inline placeholders", () => {
    // Faithful reproduction of k-w2i4xi2v content shape
    const content = `- 2026-04-17 13:22 — touched articles \`[[slug]]\`, \`[[slug|display]]\` in a code span.
- Real link added: [[evidence-levels-and-traceability]].`;
    const slugs = extractWikilinks(content).map((l) => l.slug);
    expect(slugs).toEqual(["evidence-levels-and-traceability"]);
  });
  it("inline code inside prose is stripped, surrounding wikilinks preserved", () => {
    const content = "Use \`[[foo]]\` placeholder, real ref [[bar]].";
    const slugs = extractWikilinks(content).map((l) => l.slug);
    expect(slugs).toEqual(["bar"]);
  });
});
