import { describe, it, expect } from "vitest";
import { ok } from "../../src/core/result.js";
import { createTestContainer } from "../../src/core/container.js";

describe("think synthesis (PR-5)", () => {
  it("degrades to ranked sources when no LLM is configured (stub)", async () => {
    const c = await createTestContainer();
    try {
      await c.knowledgeService.createArticle({
        title: "Auth Guide",
        category: "guide",
        content: "How authentication works in the system, using tokens.",
        tags: ["auth"],
      });

      const result = await c.searchService.think({ query: "authentication", type: "all" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const r = result.value;
      expect(r.degraded).toBe(true); // default stub generator in tests
      expect(r.contextPack.items.length).toBeGreaterThan(0);
      expect(r.answer.length).toBeGreaterThan(0);
      expect(r.citations).toHaveLength(0); // no LLM → no prose citations
      expect(r.query).toBe("authentication");
    } finally {
      await c.dispose();
    }
  });

  it("synthesizes a cited answer when a generator is available", async () => {
    const c = await createTestContainer();
    try {
      const created = await c.knowledgeService.createArticle({
        title: "Auth Guide",
        category: "guide",
        content: "Authentication uses signed tokens validated on each request.",
        tags: ["auth"],
      });
      if (!created.ok) throw new Error(`seed failed: ${created.error.message}`);

      // Inject a fake generator post-construction (the public setter used by the container).
      c.searchService.setTextGenerator({
        modelName: "fake",
        async healthCheck() {
          return ok({ ready: true as const });
        },
        async generate() {
          return ok(JSON.stringify({ answer: "Authentication uses signed tokens [1].", gaps: [] }));
        },
      });

      const result = await c.searchService.think({ query: "authentication", type: "all" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const r = result.value;
      expect(r.degraded).toBe(false);
      expect(r.answer).toContain("[1]");
      expect(r.citations.length).toBeGreaterThan(0);
      expect(r.citations[0]!.articleId).toBe(created.value.id);
    } finally {
      await c.dispose();
    }
  });
});
