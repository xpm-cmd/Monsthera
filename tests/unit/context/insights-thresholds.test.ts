import { describe, it, expect } from "vitest";
import { inspectKnowledgeArticle, inspectWorkArticle } from "../../../src/context/insights.js";
import type { KnowledgeArticle } from "../../../src/knowledge/repository.js";
import type { WorkArticle } from "../../../src/work/repository.js";

const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

function knowledge(updatedAt: string, category = "context"): KnowledgeArticle {
  return {
    updatedAt,
    content: "body",
    codeRefs: [],
    tags: [],
    category,
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

describe("inspectKnowledgeArticle per-category staleness windows (P2)", () => {
  it("durable: an ADR-category article 120 days old is NOT stale (180-day window)", async () => {
    const diag = await inspectKnowledgeArticle(knowledge(daysAgo(120), "adr"));
    expect(diag.freshness.state).not.toBe("stale");
    // 120 is past fresh(90) but under stale(180) -> attention
    expect(diag.freshness.state).toBe("attention");
  });

  it("durable: architecture / decision / guide / reference share the 90/180 window", async () => {
    for (const category of ["architecture", "decision", "guide", "reference"]) {
      const fresh = await inspectKnowledgeArticle(knowledge(daysAgo(60), category));
      expect(fresh.freshness.state, `${category} @ 60d`).toBe("fresh");
      const stale = await inspectKnowledgeArticle(knowledge(daysAgo(200), category));
      expect(stale.freshness.state, `${category} @ 200d`).toBe("stale");
    }
  });

  it("semi-durable: a pattern 60 days old is attention, 100 days old is stale (30/90 window)", async () => {
    for (const category of ["pattern", "solution", "gotcha"]) {
      const attention = await inspectKnowledgeArticle(knowledge(daysAgo(60), category));
      expect(attention.freshness.state, `${category} @ 60d`).toBe("attention");
      const stale = await inspectKnowledgeArticle(knowledge(daysAgo(100), category));
      expect(stale.freshness.state, `${category} @ 100d`).toBe("stale");
    }
  });

  it("ephemeral: a context article 60 days old stays stale (14/45 unchanged)", async () => {
    const diag = await inspectKnowledgeArticle(knowledge(daysAgo(60), "context"));
    expect(diag.freshness.state).toBe("stale");
  });

  it("ephemeral: an unknown category falls through to the 14/45 default", async () => {
    const diag = await inspectKnowledgeArticle(knowledge(daysAgo(60), "handoff"));
    expect(diag.freshness.state).toBe("stale");
    const novel = await inspectKnowledgeArticle(knowledge(daysAgo(60), "totally-made-up"));
    expect(novel.freshness.state).toBe("stale");
  });

  it("category resolution is case-insensitive", async () => {
    const diag = await inspectKnowledgeArticle(knowledge(daysAgo(120), "ADR"));
    expect(diag.freshness.state).not.toBe("stale");
  });

  it("explicit opts still WIN over the category map", async () => {
    // ADR would be fresh at 120d under its 180 window; a tight explicit staleDays forces stale.
    const diag = await inspectKnowledgeArticle(knowledge(daysAgo(120), "adr"), { freshDays: 5, staleDays: 10 });
    expect(diag.freshness.state).toBe("stale");
  });

  it("a partial explicit override (freshDays only) still inherits the category staleDays", async () => {
    // adr -> category staleDays=180; caller overrides freshDays=200 so a 150d article is fresh, not stale.
    const diag = await inspectKnowledgeArticle(knowledge(daysAgo(150), "adr"), { freshDays: 200 });
    expect(diag.freshness.state).toBe("fresh");
  });

  it("a handoff 60 days old is still stale while an ADR 120 days old is not (the core audit goal)", async () => {
    const handoff = await inspectKnowledgeArticle(knowledge(daysAgo(60), "handoff"));
    const adr = await inspectKnowledgeArticle(knowledge(daysAgo(120), "adr"));
    expect(handoff.freshness.state).toBe("stale");
    expect(adr.freshness.state).not.toBe("stale");
  });
});
