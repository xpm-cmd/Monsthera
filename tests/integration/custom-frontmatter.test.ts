import { describe, it, expect } from "vitest";
import { createTestContainer } from "../../src/core/container.js";

// ADR-020 P1: custom frontmatter authored through create/update must persist
// and round-trip through the markdown repo (storage already supported it; this
// proves the full service path now carries it end-to-end).
describe("custom frontmatter authoring round-trip (ADR-020 P1)", () => {
  it("persists extraFrontmatter set at create time", async () => {
    const c = await createTestContainer();
    try {
      const created = await c.knowledgeService.createArticle({
        title: "Custom Fields Article",
        category: "context",
        content: "body",
        extraFrontmatter: { origin: "human", ticket: "ABC-123" },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const got = await c.knowledgeService.getArticle(created.value.id);
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      expect(got.value.extraFrontmatter).toEqual({ origin: "human", ticket: "ABC-123" });
    } finally {
      await c.dispose();
    }
  });

  it("replaces the custom-frontmatter map on update", async () => {
    const c = await createTestContainer();
    try {
      const created = await c.knowledgeService.createArticle({
        title: "Update Fields Article",
        category: "context",
        content: "body",
        extraFrontmatter: { origin: "agent" },
      });
      if (!created.ok) throw new Error(`create failed: ${created.error.message}`);

      const updated = await c.knowledgeService.updateArticle(created.value.id, {
        extraFrontmatter: { origin: "distilled", distilled_from: "w-1" },
      });
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;

      const got = await c.knowledgeService.getArticle(created.value.id);
      if (!got.ok) return;
      expect(got.value.extraFrontmatter).toEqual({ origin: "distilled", distilled_from: "w-1" });
    } finally {
      await c.dispose();
    }
  });
});
