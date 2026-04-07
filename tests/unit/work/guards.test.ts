import { describe, it, expect } from "vitest";
import { workId, agentId, timestamp, WorkPhase, WorkTemplate, Priority } from "../../../src/core/types.js";
import type { WorkArticle } from "../../../src/work/repository.js";
import {
  has_objective,
  has_acceptance_criteria,
  min_enrichment_met,
  implementation_linked,
  all_reviewers_approved,
} from "../../../src/work/guards.js";

// ─── Fixture ───

function makeArticle(overrides: Partial<WorkArticle> = {}): WorkArticle {
  return {
    id: workId("w-test0001"),
    title: "Test Article",
    template: WorkTemplate.FEATURE,
    phase: WorkPhase.PLANNING,
    priority: Priority.MEDIUM,
    author: agentId("agent-1"),
    enrichmentRoles: [],
    reviewers: [],
    phaseHistory: [{ phase: WorkPhase.PLANNING, enteredAt: timestamp() }],
    tags: [],
    references: [],
    codeRefs: [],
    dependencies: [],
    blockedBy: [],
    content: "",
    createdAt: timestamp(),
    updatedAt: timestamp(),
    ...overrides,
  };
}

// ─── has_objective ───

describe("has_objective", () => {
  it("returns true when content contains '## Objective'", () => {
    const article = makeArticle({ content: "## Objective\n\nDo something useful." });
    expect(has_objective(article)).toBe(true);
  });

  it("returns true when '## Objective' is among other sections", () => {
    const article = makeArticle({
      content: "## Background\n\nSome context.\n\n## Objective\n\nThe goal.\n\n## Notes\n\nFYI.",
    });
    expect(has_objective(article)).toBe(true);
  });

  it("returns false when content is empty", () => {
    const article = makeArticle({ content: "" });
    expect(has_objective(article)).toBe(false);
  });

  it("returns false when content has 'Objective' without ## prefix", () => {
    const article = makeArticle({ content: "Objective: do something." });
    expect(has_objective(article)).toBe(false);
  });
});

// ─── has_acceptance_criteria ───

describe("has_acceptance_criteria", () => {
  it("returns true when content contains '## Acceptance Criteria'", () => {
    const article = makeArticle({ content: "## Acceptance Criteria\n\n- It works." });
    expect(has_acceptance_criteria(article)).toBe(true);
  });

  it("returns false when content is empty", () => {
    const article = makeArticle({ content: "" });
    expect(has_acceptance_criteria(article)).toBe(false);
  });

  it("returns false when content has '## acceptance criteria' (case sensitive)", () => {
    const article = makeArticle({ content: "## acceptance criteria\n\n- It works." });
    expect(has_acceptance_criteria(article)).toBe(false);
  });
});

// ─── min_enrichment_met ───

describe("min_enrichment_met", () => {
  it("returns true when contributed count >= min", () => {
    const article = makeArticle({
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("agent-arch"), status: "contributed" as const, contributedAt: timestamp() },
        { role: "security", agentId: agentId("agent-sec"), status: "contributed" as const, contributedAt: timestamp() },
      ],
    });
    expect(min_enrichment_met(article, 2)).toBe(true);
  });

  it("counts 'skipped' as met", () => {
    const article = makeArticle({
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("agent-arch"), status: "skipped" as const, contributedAt: timestamp() },
      ],
    });
    expect(min_enrichment_met(article, 1)).toBe(true);
  });

  it("does not count 'pending' as met", () => {
    const article = makeArticle({
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("agent-arch"), status: "pending" as const },
      ],
    });
    expect(min_enrichment_met(article, 1)).toBe(false);
  });

  it("returns true when min is 0 (regardless of roles)", () => {
    const article = makeArticle({
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("agent-arch"), status: "pending" as const },
      ],
    });
    expect(min_enrichment_met(article, 0)).toBe(true);
  });

  it("returns true when min is 0 and roles is empty", () => {
    const article = makeArticle({ enrichmentRoles: [] });
    expect(min_enrichment_met(article, 0)).toBe(true);
  });

  it("returns false when count < min", () => {
    const article = makeArticle({
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("agent-arch"), status: "contributed" as const, contributedAt: timestamp() },
      ],
    });
    expect(min_enrichment_met(article, 3)).toBe(false);
  });

  it("boundary: count === min returns true", () => {
    const article = makeArticle({
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("agent-arch"), status: "contributed" as const, contributedAt: timestamp() },
        { role: "security", agentId: agentId("agent-sec"), status: "skipped" as const, contributedAt: timestamp() },
      ],
    });
    expect(min_enrichment_met(article, 2)).toBe(true);
  });
});

// ─── implementation_linked ───

describe("implementation_linked", () => {
  it("returns true when content contains '## Implementation'", () => {
    const article = makeArticle({ content: "## Implementation\n\nSee PR #42." });
    expect(implementation_linked(article)).toBe(true);
  });

  it("returns false when content is empty", () => {
    const article = makeArticle({ content: "" });
    expect(implementation_linked(article)).toBe(false);
  });
});

// ─── all_reviewers_approved ───

describe("all_reviewers_approved", () => {
  it("returns true when all reviewers have status 'approved'", () => {
    const article = makeArticle({
      reviewers: [
        { agentId: agentId("agent-rev1"), status: "approved" as const, reviewedAt: timestamp() },
        { agentId: agentId("agent-rev2"), status: "approved" as const, reviewedAt: timestamp() },
      ],
    });
    expect(all_reviewers_approved(article)).toBe(true);
  });

  it("returns false when any reviewer has status 'pending'", () => {
    const article = makeArticle({
      reviewers: [
        { agentId: agentId("agent-rev1"), status: "approved" as const, reviewedAt: timestamp() },
        { agentId: agentId("agent-rev2"), status: "pending" as const },
      ],
    });
    expect(all_reviewers_approved(article)).toBe(false);
  });

  it("returns false when any reviewer has status 'changes-requested'", () => {
    const article = makeArticle({
      reviewers: [
        { agentId: agentId("agent-rev1"), status: "approved" as const, reviewedAt: timestamp() },
        { agentId: agentId("agent-rev2"), status: "changes-requested" as const, reviewedAt: timestamp() },
      ],
    });
    expect(all_reviewers_approved(article)).toBe(false);
  });

  it("returns false when reviewers array is empty", () => {
    const article = makeArticle({ reviewers: [] });
    expect(all_reviewers_approved(article)).toBe(false);
  });

  it("returns true with single reviewer approved", () => {
    const article = makeArticle({
      reviewers: [
        { agentId: agentId("agent-rev"), status: "approved" as const, reviewedAt: timestamp() },
      ],
    });
    expect(all_reviewers_approved(article)).toBe(true);
  });
});
