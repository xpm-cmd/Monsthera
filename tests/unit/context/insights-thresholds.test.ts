import { describe, it, expect } from "vitest";
import { inspectKnowledgeArticle, inspectWorkArticle } from "../../../src/context/insights.js";
import type { KnowledgeArticle } from "../../../src/knowledge/repository.js";
import type { WorkArticle } from "../../../src/work/repository.js";

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

function knowledge(updatedAt: string): KnowledgeArticle {
  return {
    updatedAt,
    content: "body",
    codeRefs: [],
    tags: [],
    category: "context",
  } as unknown as KnowledgeArticle;
}

function work(updatedAt: string): WorkArticle {
  return {
    updatedAt,
    template: "feature",
    content: "## Objective",
    references: [],
    codeRefs: [],
    reviewers: [],
  } as unknown as WorkArticle;
}

describe("inspect* freshness thresholds (PR-10)", () => {
  it("knowledge: defaults (14/45) classify a 20-day article as attention", async () => {
    const diag = await inspectKnowledgeArticle(knowledge(daysAgo(20)));
    expect(diag.freshness.state).toBe("attention");
  });

  it("knowledge: a wider freshDays moves the same article to fresh", async () => {
    const diag = await inspectKnowledgeArticle(knowledge(daysAgo(20)), { freshDays: 30, staleDays: 60 });
    expect(diag.freshness.state).toBe("fresh");
  });

  it("knowledge: a tighter staleDays moves the same article to stale", async () => {
    const diag = await inspectKnowledgeArticle(knowledge(daysAgo(20)), { freshDays: 5, staleDays: 10 });
    expect(diag.freshness.state).toBe("stale");
  });

  it("work: thresholds flow through inspectWorkArticle too", () => {
    expect(inspectWorkArticle(work(daysAgo(20))).freshness.state).toBe("attention");
    expect(inspectWorkArticle(work(daysAgo(20)), { freshDays: 30, staleDays: 60 }).freshness.state).toBe("fresh");
  });
});
