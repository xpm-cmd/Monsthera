import { describe, it, expect } from "vitest";
import {
  articleId,
  workId,
  agentId,
  sessionId,
  slug,
  timestamp,
  generateId,
  generateWorkId,
  generateArticleId,
  WorkPhase,
  Priority,
  WorkTemplate,
  EnrichmentRole,
  ReviewStatus,
  ContributionStatus,
} from "../../../src/core/types.js";

describe("factory functions", () => {
  it("articleId creates an ArticleId branded string", () => {
    const id = articleId("k-abc123");
    expect(id).toBe("k-abc123");
  });

  it("workId creates a WorkId branded string", () => {
    const id = workId("w-xyz789");
    expect(id).toBe("w-xyz789");
  });

  it("agentId creates an AgentId branded string", () => {
    const id = agentId("agent-001");
    expect(id).toBe("agent-001");
  });

  it("sessionId creates a SessionId branded string", () => {
    const id = sessionId("sess-001");
    expect(id).toBe("sess-001");
  });

  it("slug creates a Slug branded string", () => {
    const s = slug("my-article-slug");
    expect(s).toBe("my-article-slug");
  });
});

describe("timestamp()", () => {
  it("generates a current ISO string when called without argument", () => {
    const ts = timestamp();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("preserves a provided ISO string", () => {
    const iso = "2024-01-15T10:30:00.000Z";
    const ts = timestamp(iso);
    expect(ts).toBe(iso);
  });
});

describe("generateId()", () => {
  it("produces a prefixed ID", () => {
    const id = generateId("test");
    expect(id).toMatch(/^test-[a-z0-9]+$/);
  });

  it("produces unique IDs on successive calls", () => {
    const id1 = generateId("x");
    const id2 = generateId("x");
    // very unlikely to collide
    expect(id1).not.toBe(id2);
  });
});

describe("generateWorkId()", () => {
  it("starts with 'w-'", () => {
    const id = generateWorkId();
    expect(id).toMatch(/^w-/);
  });
});

describe("generateArticleId()", () => {
  it("starts with 'k-'", () => {
    const id = generateArticleId();
    expect(id).toMatch(/^k-/);
  });
});

describe("WorkPhase constants", () => {
  it("has all expected phase values", () => {
    expect(WorkPhase.PLANNING).toBe("planning");
    expect(WorkPhase.ENRICHMENT).toBe("enrichment");
    expect(WorkPhase.IMPLEMENTATION).toBe("implementation");
    expect(WorkPhase.REVIEW).toBe("review");
    expect(WorkPhase.DONE).toBe("done");
    expect(WorkPhase.CANCELLED).toBe("cancelled");
  });
});

describe("Priority constants", () => {
  it("has all expected priority values", () => {
    expect(Priority.CRITICAL).toBe("critical");
    expect(Priority.HIGH).toBe("high");
    expect(Priority.MEDIUM).toBe("medium");
    expect(Priority.LOW).toBe("low");
  });
});

describe("WorkTemplate constants", () => {
  it("has all expected template values", () => {
    expect(WorkTemplate.FEATURE).toBe("feature");
    expect(WorkTemplate.BUGFIX).toBe("bugfix");
    expect(WorkTemplate.REFACTOR).toBe("refactor");
    expect(WorkTemplate.SPIKE).toBe("spike");
  });
});

describe("EnrichmentRole constants", () => {
  it("has all expected role values", () => {
    expect(EnrichmentRole.ARCHITECTURE).toBe("architecture");
    expect(EnrichmentRole.SECURITY).toBe("security");
    expect(EnrichmentRole.PERFORMANCE).toBe("performance");
    expect(EnrichmentRole.TESTING).toBe("testing");
  });
});

describe("ReviewStatus constants", () => {
  it("has all expected status values", () => {
    expect(ReviewStatus.PENDING).toBe("pending");
    expect(ReviewStatus.APPROVED).toBe("approved");
    expect(ReviewStatus.CHANGES_REQUESTED).toBe("changes-requested");
  });
});

describe("ContributionStatus constants", () => {
  it("has all expected status values", () => {
    expect(ContributionStatus.PENDING).toBe("pending");
    expect(ContributionStatus.CONTRIBUTED).toBe("contributed");
    expect(ContributionStatus.SKIPPED).toBe("skipped");
  });
});
