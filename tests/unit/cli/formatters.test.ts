import { describe, it, expect } from "vitest";
import { formatArticle } from "../../../src/cli/formatters.js";
import type { KnowledgeArticle } from "../../../src/knowledge/repository.js";
import { articleId, slug, timestamp } from "../../../src/core/types.js";

const baseArticle: KnowledgeArticle = {
  id: articleId("k-abc123"),
  title: "Example",
  slug: slug("example"),
  category: "context",
  content: "Body text.",
  tags: ["alpha"],
  codeRefs: ["src/x.ts"],
  references: [],
  createdAt: timestamp("2026-05-30T00:00:00.000Z"),
  updatedAt: timestamp("2026-05-30T00:00:00.000Z"),
};

describe("formatArticle", () => {
  it("renders the core fields", () => {
    const output = formatArticle(baseArticle);
    expect(output).toContain("ID:        k-abc123");
    expect(output).toContain("Title:     Example");
    expect(output).toContain("Body text.");
  });

  it("renders outgoing references with a direction-labeled line", () => {
    const output = formatArticle({ ...baseArticle, references: ["k-other", "k-third"] });
    expect(output).toContain("References (outgoing): k-other, k-third");
  });

  it("shows (none) for references when there are none", () => {
    const output = formatArticle({ ...baseArticle, references: [] });
    expect(output).toContain("References (outgoing): (none)");
  });
});
