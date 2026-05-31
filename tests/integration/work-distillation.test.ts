import { describe, it, expect } from "vitest";
import { createTestContainer } from "../../src/core/container.js";
import { WorkPhase } from "../../src/core/types.js";
import type { MonstheraContainer } from "../../src/core/container.js";

const SKIP = { skipGuard: { reason: "test fast-forward" } };

async function advance(c: MonstheraContainer, id: string, phases: WorkPhase[]): Promise<void> {
  for (const phase of phases) {
    const r = await c.workService.advancePhase(id, phase, SKIP);
    if (!r.ok) throw new Error(`advance to ${phase} failed: ${r.error.message}`);
  }
}

describe("work→knowledge distillation (PR-6)", () => {
  it("distills a solution article when a bugfix reaches done", async () => {
    const c = await createTestContainer();
    try {
      const created = await c.workService.createWork({
        title: "Fix login redirect",
        template: "bugfix",
        priority: "medium",
        author: "agent-1",
        content: "## Objective\nFix it.\n## Steps to Reproduce\n1. x\n## Acceptance Criteria\n- works",
        tags: ["auth"],
        codeRefs: ["src/auth/login.ts"],
      });
      if (!created.ok) throw new Error(`create failed: ${created.error.message}`);
      const id = created.value.id;

      await advance(c, id, [WorkPhase.ENRICHMENT, WorkPhase.IMPLEMENTATION, WorkPhase.REVIEW, WorkPhase.DONE]);

      const distilled = await c.knowledgeService.getArticleBySlug(`distilled-${id}`);
      expect(distilled.ok).toBe(true);
      if (!distilled.ok) return;
      expect(distilled.value.category).toBe("solution");
      expect(distilled.value.references).toContain(id);
      expect(distilled.value.tags).toContain("distilled");
      expect(distilled.value.extraFrontmatter?.["origin"]).toBe("distilled");
      expect(distilled.value.extraFrontmatter?.["distilled_from"]).toBe(id);
    } finally {
      await c.dispose();
    }
  });

  it("does NOT distill for a spike (distillOnDone not set)", async () => {
    const c = await createTestContainer();
    try {
      const created = await c.workService.createWork({
        title: "Investigate caching",
        template: "spike",
        priority: "low",
        author: "agent-1",
        content: "## Objective\nResearch.\n## Research Questions\n- q1",
      });
      if (!created.ok) throw new Error(`create failed: ${created.error.message}`);
      const id = created.value.id;

      // Spike graph: planning → enrichment → done
      await advance(c, id, [WorkPhase.ENRICHMENT, WorkPhase.DONE]);

      const distilled = await c.knowledgeService.getArticleBySlug(`distilled-${id}`);
      expect(distilled.ok).toBe(false); // never created
    } finally {
      await c.dispose();
    }
  });
});
