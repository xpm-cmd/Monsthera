import { describe, it, expect } from "vitest";
import {
  collectCodeRefs,
  collectArticleReferences,
} from "../../../src/sessions/handoff-extractors.js";

describe("collectCodeRefs", () => {
  describe("backticked file paths", () => {
    it("extracts a single backticked .ts path", () => {
      expect(collectCodeRefs("see `src/foo.ts` for context")).toEqual(["src/foo.ts"]);
    });

    it("extracts file paths with :line suffix (regression: original regex dropped them)", () => {
      expect(collectCodeRefs("edit `src/foo.ts:42` and re-run")).toEqual(["src/foo.ts:42"]);
    });

    it("extracts multiple distinct paths in one body", () => {
      const body = "edit `src/foo.ts` and `tests/foo.test.ts:99`";
      const refs = collectCodeRefs(body);
      expect(refs).toContain("src/foo.ts");
      expect(refs).toContain("tests/foo.test.ts:99");
      expect(refs.length).toBe(2);
    });

    it("deduplicates identical paths", () => {
      expect(collectCodeRefs("`src/foo.ts` and again `src/foo.ts`")).toEqual(["src/foo.ts"]);
    });

    it("supports leading `./` and `../` relative paths", () => {
      const body = "see `./src/foo.ts` and `../bar/baz.ts`";
      const refs = collectCodeRefs(body);
      expect(refs).toContain("./src/foo.ts");
      expect(refs).toContain("../bar/baz.ts");
    });

    it("accepts md, sh, sql, json, yml, yaml, toml extensions", () => {
      const body = "`docs/readme.md` `scripts/build.sh` `migrations/001.sql` `package.json` `config.yml` `config.yaml` `Cargo.toml`";
      const refs = collectCodeRefs(body);
      expect(refs).toEqual(
        expect.arrayContaining([
          "docs/readme.md",
          "scripts/build.sh",
          "migrations/001.sql",
          "package.json",
          "config.yml",
          "config.yaml",
          "Cargo.toml",
        ]),
      );
    });
  });

  describe("regression: does NOT capture CLI commands as file paths", () => {
    // The round-6 bug — `pnpm test tests/foo.test.ts` was previously
    // captured by `[^`]+\.(ts|...)` as a single "file" entry because
    // `[^`]+` allowed whitespace.
    it("does NOT match `pnpm test tests/foo.test.ts` as a file path", () => {
      const refs = collectCodeRefs("Run `pnpm test tests/unit/sessions/foo.test.ts` to verify.");
      expect(refs).not.toContain("pnpm test tests/unit/sessions/foo.test.ts");
      expect(refs).not.toContain("tests/unit/sessions/foo.test.ts");
      expect(refs.length).toBe(0);
    });

    it("does NOT match `node dist/bin.js script.ts` as a file path", () => {
      const refs = collectCodeRefs("Try `node dist/bin.js scripts/repro.ts`.");
      expect(refs).not.toContain("node dist/bin.js scripts/repro.ts");
      expect(refs.length).toBe(0);
    });

    it("does NOT match arbitrary prose with embedded spaces and a trailing extension", () => {
      const refs = collectCodeRefs("the response was `something something foo.ts`");
      expect(refs.length).toBe(0);
    });
  });

  describe("path: citation form", () => {
    it("extracts `path:<file>` citations", () => {
      expect(collectCodeRefs("evidence: [path:src/foo.ts]")).toEqual(["src/foo.ts"]);
    });

    it("extracts `path:<file>:<line>` citations with line", () => {
      expect(collectCodeRefs("evidence: [path:src/foo.ts:42]")).toEqual(["src/foo.ts:42"]);
    });

    it("stops at whitespace, comma, and closing bracket", () => {
      const refs = collectCodeRefs("evidence: [path:src/foo.ts, path:src/bar.ts]");
      expect(refs).toEqual(["src/foo.ts", "src/bar.ts"]);
    });
  });

  describe("integration: dedup across backticked + path: forms", () => {
    it("dedupes a path that appears in both backticked and `path:` forms", () => {
      const body = "edit `src/foo.ts` (evidence: [path:src/foo.ts])";
      expect(collectCodeRefs(body)).toEqual(["src/foo.ts"]);
    });
  });

  describe("empty / no-match inputs", () => {
    it("returns empty array for an empty body", () => {
      expect(collectCodeRefs("")).toEqual([]);
    });

    it("returns empty array for a body with no recognisable refs", () => {
      expect(collectCodeRefs("This is just prose with no specific references.")).toEqual([]);
    });
  });

  describe("strips the ## Facts section so the Facts pointer is not captured", () => {
    // Every non-degraded handoff carries `## Facts (raw, for downstream
    // LLM)` ending in a backticked `.facts.json` filename. That filename
    // technically matches the regex but is structural noise, not a
    // substantive code ref the next agent cares about.
    it("does not surface the Facts pointer's .facts.json filename in codeRefs", () => {
      const body = [
        "## What's next",
        "",
        "edit `src/foo.ts:42`",
        "",
        "## Facts (raw, for downstream LLM)",
        "",
        "See [`ses-20260516-100000-claude-code.facts.json`](../sessions/ses-20260516-100000-claude-code.facts.json).",
      ].join("\n");
      const refs = collectCodeRefs(body);
      expect(refs).toContain("src/foo.ts:42");
      expect(refs).not.toContain("ses-20260516-100000-claude-code.facts.json");
    });

    it("still extracts refs from above the Facts section unchanged", () => {
      const body = [
        "Edit `src/sessions/service.ts` and `tests/unit/sessions/service.test.ts:42`.",
        "",
        "## Facts (raw, for downstream LLM)",
        "",
        "See [`ses-x.facts.json`](../sessions/ses-x.facts.json).",
      ].join("\n");
      expect(collectCodeRefs(body)).toEqual([
        "src/sessions/service.ts",
        "tests/unit/sessions/service.test.ts:42",
      ]);
    });

    it("does NOT strip when '## Facts' appears in prose (regression: round-6 dogfood bug)", () => {
      // The original `indexOf("## Facts")` matched on any occurrence, including
      // when the handoff prose mentioned the section by name. That chopped off
      // every legitimate ref below the prose mention. Anchoring to line-start
      // fixes it: only an actual section heading triggers the strip.
      const body = [
        "## TL;DR",
        "",
        "The extractor strips structural sections (like `## Facts`) before scanning.",
        "Edit `src/sessions/handoff-extractors.ts` to see the implementation.",
        "",
        "## Facts (raw, for downstream LLM)",
        "",
        "See [`ses-x.facts.json`](../sessions/ses-x.facts.json).",
      ].join("\n");
      const refs = collectCodeRefs(body);
      expect(refs).toContain("src/sessions/handoff-extractors.ts");
      expect(refs).not.toContain("ses-x.facts.json");
    });
  });

  describe("defensive entry filter — rejects malformed extractor outputs", () => {
    // Even with a tightened body-side regex, real LLM output can produce
    // surprises (nested-backtick artifacts, paren-tick sequences) that
    // could land malformed strings in `codeRefs[]`. The filter pins the
    // shape every entry must match.
    it("rejects entries containing whitespace", () => {
      // The regex SHOULDN'T match these, but if a future regex change
      // loosens it, the defensive filter still rejects spaces.
      // Construct an input that would only match if the body regex
      // accepted spaces, then assert the entry doesn't survive.
      const refs = collectCodeRefs("see `src/foo.ts` and `not a real path.ts`");
      // First ref is legitimate
      expect(refs).toContain("src/foo.ts");
      // 'not a real path.ts' has spaces — the body regex rejects it,
      // and so would the defensive filter. The test pins that we end
      // up with only the legitimate entry.
      expect(refs.length).toBe(1);
    });

    it("rejects entries with parens, brackets, or backticks", () => {
      // path: form could in principle capture weird content. Assert the
      // defensive filter rejects anything that isn't path-shaped.
      const body = "evidence: [path:foo(bar.ts] [path:src/foo.ts]";
      const refs = collectCodeRefs(body);
      // The PATH_CITATION regex stops at `]`, comma, whitespace; the
      // first citation `foo(bar.ts` would be captured by the body regex
      // but rejected by the defensive filter (contains `(`).
      expect(refs).not.toContain("foo(bar.ts");
      expect(refs).toContain("src/foo.ts");
    });
  });
});

describe("collectArticleReferences", () => {
  it("extracts work: citations", () => {
    expect(collectArticleReferences("evidence: [work:w-abc123]")).toEqual(["w-abc123"]);
  });

  it("extracts knowledge: citations", () => {
    expect(collectArticleReferences("evidence: [knowledge:auth-design]")).toEqual(["auth-design"]);
  });

  it("extracts handoff-<id>.md markdown links and prefixes them with `handoff-`", () => {
    const body = "Previous: [ses-x](handoff-ses-20260512-100000-claude-code.md)";
    expect(collectArticleReferences(body)).toEqual(["handoff-ses-20260512-100000-claude-code"]);
  });

  it("aggregates and dedupes across all three forms", () => {
    const body = [
      "evidence: [work:w-1] [knowledge:k-design]",
      "see also [ses-y](handoff-ses-20260513-100000-claude-code.md)",
      "duplicate: [work:w-1]",
    ].join("\n");
    const refs = collectArticleReferences(body);
    expect(refs).toContain("w-1");
    expect(refs).toContain("k-design");
    expect(refs).toContain("handoff-ses-20260513-100000-claude-code");
    expect(refs.length).toBe(3);
  });

  it("returns empty array for prose with no citations or links", () => {
    expect(collectArticleReferences("Just prose, no references.")).toEqual([]);
  });
});
