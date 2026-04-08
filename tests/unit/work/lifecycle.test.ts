import { describe, it, expect } from "vitest";
import { isValidTransition, checkTransition } from "../../../src/work/lifecycle.js";
import { WorkPhase, WorkTemplate, Priority, workId, agentId, timestamp } from "../../../src/core/types.js";
import type { WorkArticle } from "../../../src/work/repository.js";

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

// ─── isValidTransition ───

describe("isValidTransition", () => {
  it("planning → enrichment: true", () => {
    expect(isValidTransition(WorkPhase.PLANNING, WorkPhase.ENRICHMENT)).toBe(true);
  });

  it("enrichment → implementation: true", () => {
    expect(isValidTransition(WorkPhase.ENRICHMENT, WorkPhase.IMPLEMENTATION)).toBe(true);
  });

  it("implementation → review: true", () => {
    expect(isValidTransition(WorkPhase.IMPLEMENTATION, WorkPhase.REVIEW)).toBe(true);
  });

  it("review → done: true", () => {
    expect(isValidTransition(WorkPhase.REVIEW, WorkPhase.DONE)).toBe(true);
  });

  it("planning → cancelled: true", () => {
    expect(isValidTransition(WorkPhase.PLANNING, WorkPhase.CANCELLED)).toBe(true);
  });

  it("enrichment → cancelled: true", () => {
    expect(isValidTransition(WorkPhase.ENRICHMENT, WorkPhase.CANCELLED)).toBe(true);
  });

  it("implementation → cancelled: true", () => {
    expect(isValidTransition(WorkPhase.IMPLEMENTATION, WorkPhase.CANCELLED)).toBe(true);
  });

  it("review → cancelled: true", () => {
    expect(isValidTransition(WorkPhase.REVIEW, WorkPhase.CANCELLED)).toBe(true);
  });

  it("done → anything: false (terminal)", () => {
    expect(isValidTransition(WorkPhase.DONE, WorkPhase.PLANNING)).toBe(false);
    expect(isValidTransition(WorkPhase.DONE, WorkPhase.ENRICHMENT)).toBe(false);
    expect(isValidTransition(WorkPhase.DONE, WorkPhase.CANCELLED)).toBe(false);
  });

  it("cancelled → anything: false (terminal)", () => {
    expect(isValidTransition(WorkPhase.CANCELLED, WorkPhase.PLANNING)).toBe(false);
    expect(isValidTransition(WorkPhase.CANCELLED, WorkPhase.ENRICHMENT)).toBe(false);
    expect(isValidTransition(WorkPhase.CANCELLED, WorkPhase.DONE)).toBe(false);
  });

  it("planning → review: false (skip)", () => {
    expect(isValidTransition(WorkPhase.PLANNING, WorkPhase.REVIEW)).toBe(false);
  });

  it("planning → done: false (skip)", () => {
    expect(isValidTransition(WorkPhase.PLANNING, WorkPhase.DONE)).toBe(false);
  });

  it("enrichment → done: false (skip)", () => {
    expect(isValidTransition(WorkPhase.ENRICHMENT, WorkPhase.DONE)).toBe(false);
  });

  it("review → planning: false (backward)", () => {
    expect(isValidTransition(WorkPhase.REVIEW, WorkPhase.PLANNING)).toBe(false);
  });
});

// ─── checkTransition — structural errors ───

describe("checkTransition — structural errors", () => {
  it("terminal phase (done) → returns StateTransitionError", () => {
    const article = makeArticle({ phase: WorkPhase.DONE });
    const result = checkTransition(article, WorkPhase.PLANNING);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("StateTransitionError");
    }
  });

  it("terminal phase (cancelled) → returns StateTransitionError", () => {
    const article = makeArticle({ phase: WorkPhase.CANCELLED });
    const result = checkTransition(article, WorkPhase.PLANNING);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("StateTransitionError");
    }
  });

  it("invalid transition (planning → review) → returns StateTransitionError", () => {
    const article = makeArticle({ phase: WorkPhase.PLANNING });
    const result = checkTransition(article, WorkPhase.REVIEW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("StateTransitionError");
    }
  });

  it("error message contains correct from and to phases", () => {
    const article = makeArticle({ phase: WorkPhase.PLANNING });
    const result = checkTransition(article, WorkPhase.REVIEW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("planning");
      expect(result.error.message).toContain("review");
    }
  });

  it("terminal done error message references the from and to phases", () => {
    const article = makeArticle({ phase: WorkPhase.DONE });
    const result = checkTransition(article, WorkPhase.ENRICHMENT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("done");
      expect(result.error.message).toContain("enrichment");
    }
  });
});

// ─── checkTransition — cancellation ───

describe("checkTransition — cancellation", () => {
  it("planning → cancelled succeeds regardless of content", () => {
    const article = makeArticle({ phase: WorkPhase.PLANNING, content: "" });
    const result = checkTransition(article, WorkPhase.CANCELLED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(WorkPhase.CANCELLED);
    }
  });

  it("enrichment → cancelled succeeds regardless of content", () => {
    const article = makeArticle({ phase: WorkPhase.ENRICHMENT, content: "" });
    const result = checkTransition(article, WorkPhase.CANCELLED);
    expect(result.ok).toBe(true);
  });

  it("implementation → cancelled succeeds", () => {
    const article = makeArticle({ phase: WorkPhase.IMPLEMENTATION, content: "" });
    const result = checkTransition(article, WorkPhase.CANCELLED);
    expect(result.ok).toBe(true);
  });

  it("review → cancelled succeeds", () => {
    const article = makeArticle({ phase: WorkPhase.REVIEW, content: "" });
    const result = checkTransition(article, WorkPhase.CANCELLED);
    expect(result.ok).toBe(true);
  });
});

// ─── checkTransition — planning → enrichment guards ───

describe("checkTransition — planning → enrichment guards", () => {
  it("succeeds when content has both '## Objective' and '## Acceptance Criteria'", () => {
    const article = makeArticle({
      phase: WorkPhase.PLANNING,
      content: "## Objective\n\nDo the thing.\n\n## Acceptance Criteria\n\n- It works.",
    });
    const result = checkTransition(article, WorkPhase.ENRICHMENT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(WorkPhase.ENRICHMENT);
    }
  });

  it("fails with GuardFailedError when missing objective", () => {
    const article = makeArticle({
      phase: WorkPhase.PLANNING,
      content: "## Acceptance Criteria\n\n- It works.",
    });
    const result = checkTransition(article, WorkPhase.ENRICHMENT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("GuardFailedError");
      expect((result.error as { details?: Record<string, unknown> }).details?.guard).toBe("has_objective");
    }
  });

  it("fails with GuardFailedError when has objective but missing criteria", () => {
    const article = makeArticle({
      phase: WorkPhase.PLANNING,
      content: "## Objective\n\nDo the thing.",
    });
    const result = checkTransition(article, WorkPhase.ENRICHMENT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("GuardFailedError");
      expect((result.error as { details?: Record<string, unknown> }).details?.guard).toBe("has_acceptance_criteria");
    }
  });

  it("guard name in error matches exactly 'has_objective' when objective missing", () => {
    const article = makeArticle({ phase: WorkPhase.PLANNING, content: "" });
    const result = checkTransition(article, WorkPhase.ENRICHMENT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const details = (result.error as { details?: Record<string, unknown> }).details;
      expect(details?.guard).toBe("has_objective");
    }
  });

  it("guard name in error matches exactly 'has_acceptance_criteria' when criteria missing", () => {
    const article = makeArticle({
      phase: WorkPhase.PLANNING,
      content: "## Objective\n\nFoo.",
    });
    const result = checkTransition(article, WorkPhase.ENRICHMENT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const details = (result.error as { details?: Record<string, unknown> }).details;
      expect(details?.guard).toBe("has_acceptance_criteria");
    }
  });

  it("spike template only requires objective, not acceptance criteria", () => {
    const article = makeArticle({
      phase: WorkPhase.PLANNING,
      template: WorkTemplate.SPIKE,
      content: "## Objective\n\nExplore the thing.\n\n## Research Questions\n\n- Q1",
    });
    const result = checkTransition(article, WorkPhase.ENRICHMENT);
    expect(result.ok).toBe(true);
  });

  it("spike template still requires objective", () => {
    const article = makeArticle({
      phase: WorkPhase.PLANNING,
      template: WorkTemplate.SPIKE,
      content: "## Research Questions\n\n- Q1",
    });
    const result = checkTransition(article, WorkPhase.ENRICHMENT);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const details = (result.error as { details?: Record<string, unknown> }).details;
      expect(details?.guard).toBe("has_objective");
    }
  });
});

// ─── checkTransition — enrichment → implementation guards ───

describe("checkTransition — enrichment → implementation guards", () => {
  it("succeeds when enrichment roles have enough contributed/skipped (feature template, min=1)", () => {
    const article = makeArticle({
      phase: WorkPhase.ENRICHMENT,
      template: WorkTemplate.FEATURE,
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("agent-arch"), status: "contributed" as const, contributedAt: timestamp() },
      ],
    });
    const result = checkTransition(article, WorkPhase.IMPLEMENTATION);
    expect(result.ok).toBe(true);
  });

  it("fails with GuardFailedError when insufficient enrichment (feature template, min=1, none contributed)", () => {
    const article = makeArticle({
      phase: WorkPhase.ENRICHMENT,
      template: WorkTemplate.FEATURE,
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("agent-arch"), status: "pending" as const },
      ],
    });
    const result = checkTransition(article, WorkPhase.IMPLEMENTATION);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("GuardFailedError");
      expect((result.error as { details?: Record<string, unknown> }).details?.guard).toBe("min_enrichment_met");
    }
  });

  it("spike template (minEnrichmentCount=0) always passes even with no contributions", () => {
    const article = makeArticle({
      phase: WorkPhase.ENRICHMENT,
      template: WorkTemplate.SPIKE,
      enrichmentRoles: [],
    });
    const result = checkTransition(article, WorkPhase.IMPLEMENTATION);
    expect(result.ok).toBe(true);
  });

  it("feature template needs at least 1 contributed/skipped", () => {
    const article = makeArticle({
      phase: WorkPhase.ENRICHMENT,
      template: WorkTemplate.FEATURE,
      enrichmentRoles: [],
    });
    const result = checkTransition(article, WorkPhase.IMPLEMENTATION);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("GuardFailedError");
    }
  });

  it("skipped status counts toward enrichment min", () => {
    const article = makeArticle({
      phase: WorkPhase.ENRICHMENT,
      template: WorkTemplate.FEATURE,
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("agent-arch"), status: "skipped" as const },
      ],
    });
    const result = checkTransition(article, WorkPhase.IMPLEMENTATION);
    expect(result.ok).toBe(true);
  });
});

// ─── checkTransition — implementation → review guards ───

describe("checkTransition — implementation → review guards", () => {
  it("succeeds when content has '## Implementation'", () => {
    const article = makeArticle({
      phase: WorkPhase.IMPLEMENTATION,
      content: "## Implementation\n\nSee PR #42.",
    });
    const result = checkTransition(article, WorkPhase.REVIEW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(WorkPhase.REVIEW);
    }
  });

  it("fails with GuardFailedError('implementation_linked', ...) when missing '## Implementation'", () => {
    const article = makeArticle({
      phase: WorkPhase.IMPLEMENTATION,
      content: "## Objective\n\nDo something.",
    });
    const result = checkTransition(article, WorkPhase.REVIEW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("GuardFailedError");
      expect((result.error as { details?: Record<string, unknown> }).details?.guard).toBe("implementation_linked");
    }
  });

  it("fails when content is empty", () => {
    const article = makeArticle({ phase: WorkPhase.IMPLEMENTATION, content: "" });
    const result = checkTransition(article, WorkPhase.REVIEW);
    expect(result.ok).toBe(false);
  });
});

// ─── checkTransition — review → done guards ───

describe("checkTransition — review → done guards", () => {
  it("succeeds when all reviewers approved", () => {
    const article = makeArticle({
      phase: WorkPhase.REVIEW,
      reviewers: [
        { agentId: agentId("agent-rev-1"), status: "approved" as const, reviewedAt: timestamp() },
        { agentId: agentId("agent-rev-2"), status: "approved" as const, reviewedAt: timestamp() },
      ],
    });
    const result = checkTransition(article, WorkPhase.DONE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(WorkPhase.DONE);
    }
  });

  it("fails with GuardFailedError('all_reviewers_approved', ...) when any pending", () => {
    const article = makeArticle({
      phase: WorkPhase.REVIEW,
      reviewers: [
        { agentId: agentId("agent-rev-1"), status: "approved" as const, reviewedAt: timestamp() },
        { agentId: agentId("agent-rev-2"), status: "pending" as const },
      ],
    });
    const result = checkTransition(article, WorkPhase.DONE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("GuardFailedError");
      expect((result.error as { details?: Record<string, unknown> }).details?.guard).toBe("all_reviewers_approved");
    }
  });

  it("fails when reviewers array is empty", () => {
    const article = makeArticle({
      phase: WorkPhase.REVIEW,
      reviewers: [],
    });
    const result = checkTransition(article, WorkPhase.DONE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("GuardFailedError");
      expect((result.error as { details?: Record<string, unknown> }).details?.guard).toBe("all_reviewers_approved");
    }
  });

  it("fails when any reviewer has changes-requested", () => {
    const article = makeArticle({
      phase: WorkPhase.REVIEW,
      reviewers: [
        { agentId: agentId("agent-rev-1"), status: "approved" as const, reviewedAt: timestamp() },
        { agentId: agentId("agent-rev-2"), status: "changes-requested" as const, reviewedAt: timestamp() },
      ],
    });
    const result = checkTransition(article, WorkPhase.DONE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("GuardFailedError");
    }
  });
});
