import { describe, it, expect } from "vitest";
import { toSlug, uniqueSlug } from "../../../src/knowledge/slug.js";

describe("toSlug", () => {
  it("converts title with spaces to kebab-case", () => {
    expect(toSlug("Hello World")).toBe("hello-world");
  });

  it("removes special characters and normalises separators", () => {
    expect(toSlug("API Design & Best Practices!")).toBe("api-design-best-practices");
  });

  it("collapses multiple spaces and trims", () => {
    expect(toSlug("  spaces  and   tabs  ")).toBe("spaces-and-tabs");
  });

  it("replaces underscores with hyphens", () => {
    expect(toSlug("under_score_case")).toBe("under-score-case");
  });

  it("lowercases already-kebab-case titles", () => {
    expect(toSlug("Already-Kebab-Case")).toBe("already-kebab-case");
  });

  it("returns 'untitled' for empty string", () => {
    expect(toSlug("")).toBe("untitled");
  });

  it("returns 'untitled' for all-hyphen string", () => {
    expect(toSlug("---")).toBe("untitled");
  });

  it("returns 'untitled' for all special characters", () => {
    expect(toSlug("!@#$%")).toBe("untitled");
  });

  it("preserves numeric characters", () => {
    expect(toSlug("123 Numbers")).toBe("123-numbers");
  });

  it("trims leading/trailing hyphens after processing", () => {
    expect(toSlug("  ---leading-trailing---  ")).toBe("leading-trailing");
  });
});

describe("uniqueSlug", () => {
  it("returns base slug when no collision", () => {
    const existing = new Set(["other-slug"]);
    expect(uniqueSlug("Hello World", existing)).toBe("hello-world");
  });

  it("appends -2 on a single collision", () => {
    const existing = new Set(["hello-world"]);
    expect(uniqueSlug("Hello World", existing)).toBe("hello-world-2");
  });

  it("appends -3 when base and -2 both exist", () => {
    const existing = new Set(["hello-world", "hello-world-2"]);
    expect(uniqueSlug("Hello World", existing)).toBe("hello-world-3");
  });

  it("returns base slug for an empty set", () => {
    expect(uniqueSlug("Hello World", new Set())).toBe("hello-world");
  });

  it("produces sequential suffixes for repeated use of the same title", () => {
    const existing = new Set<string>();

    const first = uniqueSlug("My Article", existing);
    expect(first).toBe("my-article");
    existing.add(first);

    const second = uniqueSlug("My Article", existing);
    expect(second).toBe("my-article-2");
    existing.add(second);

    const third = uniqueSlug("My Article", existing);
    expect(third).toBe("my-article-3");
  });
});
