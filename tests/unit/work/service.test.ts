import { describe, it, expect, beforeEach } from "vitest";
import { WorkService } from "../../../src/work/service.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { ErrorCode } from "../../../src/core/errors.js";
import { createLogger } from "../../../src/core/logger.js";
import { WorkPhase, WorkTemplate, Priority } from "../../../src/core/types.js";
import type { WorkArticle } from "../../../src/work/repository.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createService() {
  const workRepo = new InMemoryWorkArticleRepository();
  const logger = createLogger({ level: "warn", domain: "test" });
  const service = new WorkService({ workRepo, logger });
  return { service, workRepo, logger };
}

const validCreateInput = {
  title: "Test Work Article",
  template: WorkTemplate.FEATURE,
  priority: Priority.MEDIUM,
  author: "agent-123",
};

async function seedWork(
  service: WorkService,
  overrides?: Record<string, unknown>,
): Promise<WorkArticle> {
  const result = await service.createWork({ ...validCreateInput, ...overrides });
  if (!result.ok) throw new Error(`seed failed: ${result.error.message}`);
  return result.value;
}

// ---------------------------------------------------------------------------
// createWork
// ---------------------------------------------------------------------------

describe("createWork", () => {
  let service: WorkService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("creates and returns a work article on happy path", async () => {
    const result = await service.createWork(validCreateInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe(validCreateInput.title);
    expect(result.value.template).toBe(validCreateInput.template);
    expect(result.value.priority).toBe(validCreateInput.priority);
    expect(result.value.author).toBe(validCreateInput.author);
    expect(result.value.id).toBeTruthy();
    expect(result.value.phase).toBe(WorkPhase.PLANNING);
  });

  it("returns ValidationError when title is missing", async () => {
    const { title: _title, ...withoutTitle } = validCreateInput;
    const result = await service.createWork(withoutTitle);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("returns ValidationError when template is invalid", async () => {
    const result = await service.createWork({ ...validCreateInput, template: "invalid-template" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("returns ValidationError when priority is invalid", async () => {
    const result = await service.createWork({ ...validCreateInput, priority: "super-urgent" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });
});

// ---------------------------------------------------------------------------
// getWork
// ---------------------------------------------------------------------------

describe("getWork", () => {
  let service: WorkService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("retrieves an existing work article by id", async () => {
    const article = await seedWork(service);
    const result = await service.getWork(article.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe(article.id);
    expect(result.value.title).toBe(article.title);
  });

  it("returns NotFoundError for a non-existent id", async () => {
    const result = await service.getWork("nonexistent-id");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// updateWork
// ---------------------------------------------------------------------------

describe("updateWork", () => {
  let service: WorkService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("updates a work article and returns the updated value", async () => {
    const article = await seedWork(service);
    const result = await service.updateWork(article.id, { title: "Updated Title" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe("Updated Title");
    expect(result.value.priority).toBe(article.priority);
  });

  it("returns ValidationError for an invalid field (empty title)", async () => {
    const article = await seedWork(service);
    const result = await service.updateWork(article.id, { title: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it("returns NotFoundError when the work article does not exist", async () => {
    const result = await service.updateWork("ghost-id", { title: "Irrelevant" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("accepts an empty update object and returns article with updated timestamp", async () => {
    const article = await seedWork(service);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const result = await service.updateWork(article.id, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe(article.title);
    expect(result.value.updatedAt).not.toBe(article.updatedAt);
  });
});

// ---------------------------------------------------------------------------
// deleteWork
// ---------------------------------------------------------------------------

describe("deleteWork", () => {
  let service: WorkService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("deletes a work article successfully", async () => {
    const article = await seedWork(service);
    const deleteResult = await service.deleteWork(article.id);
    expect(deleteResult.ok).toBe(true);

    const findResult = await service.getWork(article.id);
    expect(findResult.ok).toBe(false);
  });

  it("returns NotFoundError when work article does not exist", async () => {
    const result = await service.deleteWork("ghost-id");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------
// listWork
// ---------------------------------------------------------------------------

describe("listWork", () => {
  let service: WorkService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("returns all work articles when no phase filter is provided", async () => {
    await seedWork(service, { title: "A" });
    await seedWork(service, { title: "B" });
    await seedWork(service, { title: "C" });

    const result = await service.listWork();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
  });

  it("filters by phase when provided", async () => {
    await seedWork(service, { title: "A" });
    await seedWork(service, { title: "B" });

    // All created articles start in PLANNING phase
    const result = await service.listWork(WorkPhase.PLANNING);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value.every((a) => a.phase === WorkPhase.PLANNING)).toBe(true);
  });

  it("returns empty array when no articles match the phase", async () => {
    await seedWork(service, { title: "A" });

    const result = await service.listWork(WorkPhase.DONE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// advancePhase
// ---------------------------------------------------------------------------

describe("advancePhase", () => {
  let service: WorkService;

  beforeEach(() => {
    ({ service } = createService());
  });

  it("succeeds for a valid transition (planning → enrichment with guards met)", async () => {
    // Create article with content that satisfies planning→enrichment guards
    const contentWithGuards = "## Objective\nDo the thing.\n\n## Acceptance Criteria\n- [ ] Works.";
    const article = await seedWork(service, { content: contentWithGuards });

    const result = await service.advancePhase(article.id, WorkPhase.ENRICHMENT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phase).toBe(WorkPhase.ENRICHMENT);
  });

  it("returns NotFoundError for a non-existent id", async () => {
    const result = await service.advancePhase("ghost-id", WorkPhase.ENRICHMENT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("returns error when guard fails (planning → enrichment without required content)", async () => {
    // Article created without the required Objective and Acceptance Criteria sections
    const article = await seedWork(service, { content: "Just a description." });

    const result = await service.advancePhase(article.id, WorkPhase.ENRICHMENT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Should be either GUARD_FAILED or STATE_TRANSITION_INVALID
    expect([ErrorCode.GUARD_FAILED, ErrorCode.STATE_TRANSITION_INVALID]).toContain(result.error.code);
  });

  it("returns StateTransitionError for an invalid structural transition", async () => {
    // Can't go planning → done directly
    const article = await seedWork(service);
    const result = await service.advancePhase(article.id, WorkPhase.DONE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.STATE_TRANSITION_INVALID);
  });
});

// ---------------------------------------------------------------------------
// contributeEnrichment
// ---------------------------------------------------------------------------

describe("contributeEnrichment", () => {
  it("marks enrichment role as contributed", async () => {
    const { service } = createService();
    const createResult = await service.createWork({
      title: "Feature Work",
      template: "feature",
      priority: "medium",
      author: "agent-1",
    });
    if (!createResult.ok) throw new Error("setup failed");
    const result = await service.contributeEnrichment(createResult.value.id, "architecture", "contributed");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const role = result.value.enrichmentRoles.find(r => r.role === "architecture");
    expect(role?.status).toBe("contributed");
  });
});

// ---------------------------------------------------------------------------
// assignReviewer
// ---------------------------------------------------------------------------

describe("assignReviewer", () => {
  it("adds a reviewer to the article", async () => {
    const { service } = createService();
    const createResult = await service.createWork({
      title: "Feature Work",
      template: "feature",
      priority: "medium",
      author: "agent-1",
    });
    if (!createResult.ok) throw new Error("setup failed");
    const result = await service.assignReviewer(createResult.value.id, "reviewer-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reviewers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// submitReview
// ---------------------------------------------------------------------------

describe("submitReview", () => {
  it("records review outcome", async () => {
    const { service } = createService();
    const createResult = await service.createWork({
      title: "Feature Work",
      template: "feature",
      priority: "medium",
      author: "agent-1",
    });
    if (!createResult.ok) throw new Error("setup failed");
    await service.assignReviewer(createResult.value.id, "reviewer-1");
    const result = await service.submitReview(createResult.value.id, "reviewer-1", "approved");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.reviewers[0]?.status).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// addDependency
// ---------------------------------------------------------------------------

describe("addDependency", () => {
  it("adds a blocking dependency", async () => {
    const { service } = createService();
    const a = await service.createWork({ title: "A", template: "feature", priority: "medium", author: "agent-1" });
    const b = await service.createWork({ title: "B", template: "feature", priority: "medium", author: "agent-1" });
    if (!a.ok || !b.ok) throw new Error("setup failed");
    const result = await service.addDependency(a.value.id, b.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.blockedBy).toContain(b.value.id);
  });
});

// ---------------------------------------------------------------------------
// removeDependency
// ---------------------------------------------------------------------------

describe("removeDependency", () => {
  it("removes a blocking dependency", async () => {
    const { service } = createService();
    const a = await service.createWork({ title: "A", template: "feature", priority: "medium", author: "agent-1" });
    const b = await service.createWork({ title: "B", template: "feature", priority: "medium", author: "agent-1" });
    if (!a.ok || !b.ok) throw new Error("setup failed");
    await service.addDependency(a.value.id, b.value.id);
    const result = await service.removeDependency(a.value.id, b.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.blockedBy).not.toContain(b.value.id);
  });
});
