import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { OrchestrationService } from "../../../src/orchestration/service.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { InMemoryOrchestrationEventRepository } from "../../../src/orchestration/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { WorkPhase, WorkTemplate, Priority, agentId } from "../../../src/core/types.js";
import { ErrorCode } from "../../../src/core/errors.js";
import type { WorkArticle } from "../../../src/work/repository.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestService(opts?: { autoAdvance?: boolean; pollIntervalMs?: number }) {
  const workRepo = new InMemoryWorkArticleRepository();
  const orchestrationRepo = new InMemoryOrchestrationEventRepository();
  const logger = createLogger({ level: "warn", domain: "test" });
  const service = new OrchestrationService({
    workRepo,
    orchestrationRepo,
    logger,
    autoAdvance: opts?.autoAdvance,
    pollIntervalMs: opts?.pollIntervalMs,
  });
  return { service, workRepo, orchestrationRepo, logger };
}

async function seedWork(
  workRepo: InMemoryWorkArticleRepository,
  overrides?: Partial<{ title: string; content: string }>,
): Promise<WorkArticle> {
  const result = await workRepo.create({
    title: overrides?.title ?? "Test Work",
    template: WorkTemplate.FEATURE,
    priority: Priority.MEDIUM,
    author: agentId("agent-1"),
  });
  if (!result.ok) throw new Error("seed failed");
  let article = result.value;
  if (overrides?.content) {
    const updateResult = await workRepo.update(article.id, { content: overrides.content });
    if (!updateResult.ok) throw new Error("update failed");
    article = updateResult.value;
  }
  return article;
}

// ---------------------------------------------------------------------------
// scanActiveWork
// ---------------------------------------------------------------------------

describe("scanActiveWork", () => {
  let service: OrchestrationService;
  let workRepo: InMemoryWorkArticleRepository;

  beforeEach(() => {
    ({ service, workRepo } = createTestService());
  });

  it("returns empty array when no work exists", async () => {
    const result = await service.scanActiveWork();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("returns only active (non-terminal) work articles", async () => {
    const active = await seedWork(workRepo, { title: "Active" });
    const done = await seedWork(workRepo, { title: "Done", content: "## Objective\n\n## Acceptance Criteria\n" });
    // Advance "Done" article all the way to done phase
    await workRepo.advancePhase(done.id, WorkPhase.ENRICHMENT);
    // Contribute enrichments to meet min count for feature template
    await workRepo.contributeEnrichment(done.id, "architecture", "contributed");
    await workRepo.advancePhase(done.id, WorkPhase.IMPLEMENTATION);
    await workRepo.update(done.id, { content: "## Objective\n\n## Acceptance Criteria\n\n## Implementation\n" });
    await workRepo.advancePhase(done.id, WorkPhase.REVIEW);
    await workRepo.assignReviewer(done.id, agentId("reviewer-1"));
    await workRepo.submitReview(done.id, agentId("reviewer-1"), "approved");
    await workRepo.advancePhase(done.id, WorkPhase.DONE);

    const result = await service.scanActiveWork();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.id).toBe(active.id);
  });

  it("excludes done and cancelled articles", async () => {
    const planning = await seedWork(workRepo, { title: "Planning" });

    // Create and cancel an article
    const cancelled = await seedWork(workRepo, { title: "Cancelled" });
    await workRepo.advancePhase(cancelled.id, WorkPhase.CANCELLED);

    const result = await service.scanActiveWork();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.id).toBe(planning.id);
  });
});

// ---------------------------------------------------------------------------
// evaluateReadiness
// ---------------------------------------------------------------------------

describe("evaluateReadiness", () => {
  let service: OrchestrationService;
  let workRepo: InMemoryWorkArticleRepository;
  let orchestrationRepo: InMemoryOrchestrationEventRepository;

  beforeEach(() => {
    ({ service, workRepo, orchestrationRepo } = createTestService());
  });

  it("returns not ready for article in terminal phase (done)", async () => {
    const article = await seedWork(workRepo, { content: "## Objective\n\n## Acceptance Criteria\n" });
    await workRepo.advancePhase(article.id, WorkPhase.ENRICHMENT);
    await workRepo.contributeEnrichment(article.id, "architecture", "contributed");
    await workRepo.advancePhase(article.id, WorkPhase.IMPLEMENTATION);
    await workRepo.update(article.id, { content: "## Objective\n\n## Acceptance Criteria\n\n## Implementation\n" });
    await workRepo.advancePhase(article.id, WorkPhase.REVIEW);
    await workRepo.assignReviewer(article.id, agentId("reviewer-1"));
    await workRepo.submitReview(article.id, agentId("reviewer-1"), "approved");
    await workRepo.advancePhase(article.id, WorkPhase.DONE);

    const result = await service.evaluateReadiness(article.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ready).toBe(false);
  });

  it("returns nextPhase as null for terminal phase", async () => {
    const article = await seedWork(workRepo, { content: "## Objective\n\n## Acceptance Criteria\n" });
    await workRepo.advancePhase(article.id, WorkPhase.ENRICHMENT);
    await workRepo.contributeEnrichment(article.id, "architecture", "contributed");
    await workRepo.advancePhase(article.id, WorkPhase.IMPLEMENTATION);
    await workRepo.update(article.id, { content: "## Objective\n\n## Acceptance Criteria\n\n## Implementation\n" });
    await workRepo.advancePhase(article.id, WorkPhase.REVIEW);
    await workRepo.assignReviewer(article.id, agentId("reviewer-1"));
    await workRepo.submitReview(article.id, agentId("reviewer-1"), "approved");
    await workRepo.advancePhase(article.id, WorkPhase.DONE);

    const result = await service.evaluateReadiness(article.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nextPhase).toBeNull();
  });

  it("returns ready=true when all guards pass (planning to enrichment with objective)", async () => {
    const article = await seedWork(workRepo, {
      content: "## Objective\nDo the thing\n\n## Acceptance Criteria\nIt works\n",
    });

    const result = await service.evaluateReadiness(article.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ready).toBe(true);
    expect(result.value.nextPhase).toBe(WorkPhase.ENRICHMENT);
  });

  it("returns ready=false when guards fail (planning to enrichment without objective)", async () => {
    const article = await seedWork(workRepo); // default content has no filled-in objective

    const result = await service.evaluateReadiness(article.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The default template content includes "## Objective\n\n" heading but has_objective checks includes("## Objective")
    // which will pass. Let's use content without the heading at all.
    // Actually the generated content DOES include ## Objective. Let's use empty content.
    const article2 = await seedWork(workRepo, { content: "No headings here" });
    const result2 = await service.evaluateReadiness(article2.id);
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.value.ready).toBe(false);
  });

  it("returns individual guard results showing which passed/failed", async () => {
    // Feature template requires has_objective and has_acceptance_criteria
    const article = await seedWork(workRepo, {
      content: "## Objective\nDo something\n",
    });

    const result = await service.evaluateReadiness(article.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.guardResults.length).toBeGreaterThan(0);

    const objectiveGuard = result.value.guardResults.find((g) => g.name === "has_objective");
    expect(objectiveGuard).toBeDefined();
    expect(objectiveGuard!.passed).toBe(true);

    const acGuard = result.value.guardResults.find((g) => g.name === "has_acceptance_criteria");
    expect(acGuard).toBeDefined();
    expect(acGuard!.passed).toBe(false);
  });

  it("logs guard_evaluated event to orchestration repo", async () => {
    const article = await seedWork(workRepo, {
      content: "## Objective\nDo the thing\n\n## Acceptance Criteria\nIt works\n",
    });

    await service.evaluateReadiness(article.id);

    const events = await orchestrationRepo.findByType("guard_evaluated");
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.length).toBeGreaterThan(0);
    expect(events.value[0]!.workId).toBe(article.id);
  });

  it("returns NotFoundError for non-existent work ID", async () => {
    const result = await service.evaluateReadiness("w-nonexistent");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("evaluates enrichment to implementation transition correctly", async () => {
    // Use spike template: minEnrichmentCount is 0, so it auto-passes
    const createResult = await workRepo.create({
      title: "Spike Work",
      template: WorkTemplate.SPIKE,
      priority: Priority.MEDIUM,
      author: agentId("agent-1"),
      content: "## Objective\nResearch\n\n## Research Questions\nWhat?\n",
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;
    const article = createResult.value;
    // Advance to enrichment (spike only requires has_objective, no acceptance criteria)
    await workRepo.advancePhase(article.id, WorkPhase.ENRICHMENT);

    const result = await service.evaluateReadiness(article.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currentPhase).toBe(WorkPhase.ENRICHMENT);
    expect(result.value.nextPhase).toBe(WorkPhase.IMPLEMENTATION);
    expect(result.value.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// tryAdvance
// ---------------------------------------------------------------------------

describe("tryAdvance", () => {
  let service: OrchestrationService;
  let workRepo: InMemoryWorkArticleRepository;
  let orchestrationRepo: InMemoryOrchestrationEventRepository;

  beforeEach(() => {
    ({ service, workRepo, orchestrationRepo } = createTestService());
  });

  it("advances article when ready", async () => {
    const article = await seedWork(workRepo, {
      content: "## Objective\nDo the thing\n\n## Acceptance Criteria\nIt works\n",
    });

    const result = await service.tryAdvance(article.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.article.phase).toBe(WorkPhase.ENRICHMENT);
  });

  it("returns GuardFailedError when not ready", async () => {
    const article = await seedWork(workRepo, { content: "No headings" });

    const result = await service.tryAdvance(article.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.GUARD_FAILED);
  });

  it("logs phase_advanced event on success", async () => {
    const article = await seedWork(workRepo, {
      content: "## Objective\nDo the thing\n\n## Acceptance Criteria\nIt works\n",
    });

    await service.tryAdvance(article.id);

    const events = await orchestrationRepo.findByType("phase_advanced");
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.length).toBeGreaterThan(0);
    expect(events.value[0]!.workId).toBe(article.id);
  });

  it("does not log error_occurred event on guard failure (guard failure is expected behavior)", async () => {
    const article = await seedWork(workRepo, { content: "No headings" });

    const result = await service.tryAdvance(article.id);
    expect(result.ok).toBe(false);

    // Guard failures are not errors — they are normal business outcomes
    const events = await orchestrationRepo.findByType("error_occurred");
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.length).toBe(0);
  });

  it("returns NotFoundError for non-existent ID", async () => {
    const result = await service.tryAdvance("w-nonexistent");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it("returns correct AdvanceResult with from/to/article", async () => {
    const article = await seedWork(workRepo, {
      content: "## Objective\nDo the thing\n\n## Acceptance Criteria\nIt works\n",
    });

    const result = await service.tryAdvance(article.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.from).toBe(WorkPhase.PLANNING);
    expect(result.value.to).toBe(WorkPhase.ENRICHMENT);
    expect(result.value.workId).toBe(article.id);
    expect(result.value.article).toBeDefined();
    expect(result.value.article.phase).toBe(WorkPhase.ENRICHMENT);
  });

  it("cannot advance terminal phase article", async () => {
    const article = await seedWork(workRepo);
    await workRepo.advancePhase(article.id, WorkPhase.CANCELLED);

    const result = await service.tryAdvance(article.id);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planWave
// ---------------------------------------------------------------------------

describe("planWave", () => {
  let service: OrchestrationService;
  let workRepo: InMemoryWorkArticleRepository;
  let orchestrationRepo: InMemoryOrchestrationEventRepository;

  beforeEach(() => {
    ({ service, workRepo, orchestrationRepo } = createTestService());
  });

  it("returns empty plan when no articles exist", async () => {
    const result = await service.planWave();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(0);
    expect(result.value.blockedItems).toHaveLength(0);
  });

  it("includes ready articles in items", async () => {
    const article = await seedWork(workRepo, {
      content: "## Objective\nDo the thing\n\n## Acceptance Criteria\nIt works\n",
    });

    const result = await service.planWave();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.length).toBeGreaterThan(0);
    expect(result.value.items[0]!.workId).toBe(article.id);
    expect(result.value.items[0]!.from).toBe(WorkPhase.PLANNING);
    expect(result.value.items[0]!.to).toBe(WorkPhase.ENRICHMENT);
  });

  it("excludes articles with unresolved blockedBy dependencies", async () => {
    const blocker = await seedWork(workRepo, { title: "Blocker" });
    const blocked = await seedWork(workRepo, {
      title: "Blocked",
      content: "## Objective\nDo the thing\n\n## Acceptance Criteria\nIt works\n",
    });
    await workRepo.addDependency(blocked.id, blocker.id);

    const result = await service.planWave();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The blocked article should not be in items
    const blockedItem = result.value.items.find((i) => i.workId === blocked.id);
    expect(blockedItem).toBeUndefined();
    // It should appear in blockedItems
    const blockedEntry = result.value.blockedItems.find((i) => i.workId === blocked.id);
    expect(blockedEntry).toBeDefined();
  });

  it("respects dependency resolution (done dependencies are not blocking)", async () => {
    // Create a blocker and advance it to done
    const blocker = await seedWork(workRepo, {
      title: "Blocker",
      content: "## Objective\nDone\n\n## Acceptance Criteria\nDone\n",
    });
    await workRepo.advancePhase(blocker.id, WorkPhase.ENRICHMENT);
    await workRepo.contributeEnrichment(blocker.id, "architecture", "contributed");
    await workRepo.advancePhase(blocker.id, WorkPhase.IMPLEMENTATION);
    await workRepo.update(blocker.id, { content: "## Objective\nDone\n\n## Acceptance Criteria\nDone\n\n## Implementation\nDone\n" });
    await workRepo.advancePhase(blocker.id, WorkPhase.REVIEW);
    await workRepo.assignReviewer(blocker.id, agentId("reviewer-1"));
    await workRepo.submitReview(blocker.id, agentId("reviewer-1"), "approved");
    await workRepo.advancePhase(blocker.id, WorkPhase.DONE);

    // Create a dependent article that has the done blocker
    const dependent = await seedWork(workRepo, {
      title: "Dependent",
      content: "## Objective\nDo the thing\n\n## Acceptance Criteria\nIt works\n",
    });
    await workRepo.addDependency(dependent.id, blocker.id);

    const result = await service.planWave();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The dependent should be in items since the blocker is done
    const item = result.value.items.find((i) => i.workId === dependent.id);
    expect(item).toBeDefined();
  });

  it("skips terminal-phase articles", async () => {
    const article = await seedWork(workRepo);
    await workRepo.advancePhase(article.id, WorkPhase.CANCELLED);

    const result = await service.planWave();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items).toHaveLength(0);
  });

  it("logs wave planning event", async () => {
    await seedWork(workRepo, {
      content: "## Objective\nDo the thing\n\n## Acceptance Criteria\nIt works\n",
    });

    await service.planWave();

    const events = await orchestrationRepo.findRecent(10);
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// executeWave
// ---------------------------------------------------------------------------

describe("executeWave", () => {
  let service: OrchestrationService;
  let workRepo: InMemoryWorkArticleRepository;

  beforeEach(() => {
    ({ service, workRepo } = createTestService());
  });

  it("advances all items in the wave plan", async () => {
    const a1 = await seedWork(workRepo, {
      title: "A1",
      content: "## Objective\nDo A1\n\n## Acceptance Criteria\nDone\n",
    });
    const a2 = await seedWork(workRepo, {
      title: "A2",
      content: "## Objective\nDo A2\n\n## Acceptance Criteria\nDone\n",
    });

    const planResult = await service.planWave();
    expect(planResult.ok).toBe(true);
    if (!planResult.ok) return;

    const waveResult = await service.executeWave(planResult.value);
    expect(waveResult.ok).toBe(true);
    if (!waveResult.ok) return;
    expect(waveResult.value.advanced).toHaveLength(2);
    expect(waveResult.value.failed).toHaveLength(0);

    // Verify articles actually advanced
    const r1 = await workRepo.findById(a1.id);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.phase).toBe(WorkPhase.ENRICHMENT);

    const r2 = await workRepo.findById(a2.id);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.phase).toBe(WorkPhase.ENRICHMENT);
  });

  it("reports failures for items that fail to advance", async () => {
    const article = await seedWork(workRepo, { content: "No headings" });

    // Manually construct a wave plan with an item that will fail guards
    const fakePlan = {
      items: [{ workId: article.id as string, from: WorkPhase.PLANNING, to: WorkPhase.ENRICHMENT }],
      blockedItems: [],
    };

    const waveResult = await service.executeWave(fakePlan);
    expect(waveResult.ok).toBe(true);
    if (!waveResult.ok) return;
    expect(waveResult.value.advanced).toHaveLength(0);
    expect(waveResult.value.failed).toHaveLength(1);
    expect(waveResult.value.failed[0]!.workId).toBe(article.id);
  });

  it("returns empty results for empty plan", async () => {
    const emptyPlan = { items: [], blockedItems: [] };

    const waveResult = await service.executeWave(emptyPlan);
    expect(waveResult.ok).toBe(true);
    if (!waveResult.ok) return;
    expect(waveResult.value.advanced).toHaveLength(0);
    expect(waveResult.value.failed).toHaveLength(0);
  });

  it("handles mixed success and failure", async () => {
    const ready = await seedWork(workRepo, {
      title: "Ready",
      content: "## Objective\nDo it\n\n## Acceptance Criteria\nDone\n",
    });
    const notReady = await seedWork(workRepo, {
      title: "Not Ready",
      content: "No headings",
    });

    const fakePlan = {
      items: [
        { workId: ready.id as string, from: WorkPhase.PLANNING, to: WorkPhase.ENRICHMENT },
        { workId: notReady.id as string, from: WorkPhase.PLANNING, to: WorkPhase.ENRICHMENT },
      ],
      blockedItems: [],
    };

    const waveResult = await service.executeWave(fakePlan);
    expect(waveResult.ok).toBe(true);
    if (!waveResult.ok) return;
    expect(waveResult.value.advanced).toHaveLength(1);
    expect(waveResult.value.advanced[0]!.workId).toBe(ready.id);
    expect(waveResult.value.failed).toHaveLength(1);
    expect(waveResult.value.failed[0]!.workId).toBe(notReady.id);
  });
});

// ---------------------------------------------------------------------------
// Auto-advance loop
// ---------------------------------------------------------------------------

describe("Auto-advance loop", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not start when autoAdvance is false", () => {
    const { service } = createTestService({ autoAdvance: false });
    expect(service.isRunning).toBe(false);
  });

  it("starts and sets isRunning to true", () => {
    const { service } = createTestService({ autoAdvance: true, pollIntervalMs: 5000 });
    service.start();
    expect(service.isRunning).toBe(true);
    service.stop();
  });

  it("stop clears the interval and sets isRunning to false", () => {
    const { service } = createTestService({ autoAdvance: true, pollIntervalMs: 5000 });
    service.start();
    expect(service.isRunning).toBe(true);
    service.stop();
    expect(service.isRunning).toBe(false);
  });

  it("start is idempotent (calling twice does not create double intervals)", () => {
    const { service } = createTestService({ autoAdvance: true, pollIntervalMs: 5000 });
    service.start();
    service.start();
    expect(service.isRunning).toBe(true);
    service.stop();
    expect(service.isRunning).toBe(false);
  });

  it("polling respects template autoAdvance flag (does not advance when template disallows)", async () => {
    vi.useFakeTimers();

    const { service, workRepo } = createTestService({ autoAdvance: true, pollIntervalMs: 100 });

    // Seed a ready article — all templates have autoAdvance=false
    await seedWork(workRepo, {
      content: "## Objective\nDo the thing\n\n## Acceptance Criteria\nIt works\n",
    });

    service.start();

    // Advance time past one poll interval
    await vi.advanceTimersByTimeAsync(150);

    service.stop();

    // Article should NOT be advanced since template autoAdvance is false
    const allArticles = await workRepo.findMany();
    expect(allArticles.ok).toBe(true);
    if (!allArticles.ok) return;
    const stillPlanning = allArticles.value.filter((a) => a.phase === WorkPhase.PLANNING);
    expect(stillPlanning).toHaveLength(1);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Event logging
// ---------------------------------------------------------------------------

describe("Event logging", () => {
  let service: OrchestrationService;
  let workRepo: InMemoryWorkArticleRepository;
  let orchestrationRepo: InMemoryOrchestrationEventRepository;

  beforeEach(() => {
    ({ service, workRepo, orchestrationRepo } = createTestService());
  });

  it("evaluateReadiness logs guard results in event details", async () => {
    const article = await seedWork(workRepo, {
      content: "## Objective\nDo the thing\n\n## Acceptance Criteria\nIt works\n",
    });

    await service.evaluateReadiness(article.id);

    const events = await orchestrationRepo.findByType("guard_evaluated");
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.length).toBeGreaterThan(0);
    const event = events.value[0]!;
    expect(event.details).toBeDefined();
    expect(event.details.guardResults).toBeDefined();
    expect(Array.isArray(event.details.guardResults)).toBe(true);
    const guardResults = event.details.guardResults as Array<{ name: string; passed: boolean }>;
    expect(guardResults.length).toBeGreaterThan(0);
    expect(guardResults[0]!.name).toBeDefined();
    expect(typeof guardResults[0]!.passed).toBe("boolean");
  });

  it("tryAdvance logs from/to phases in event details", async () => {
    const article = await seedWork(workRepo, {
      content: "## Objective\nDo the thing\n\n## Acceptance Criteria\nIt works\n",
    });

    await service.tryAdvance(article.id);

    const events = await orchestrationRepo.findByType("phase_advanced");
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value.length).toBeGreaterThan(0);
    const event = events.value[0]!;
    expect(event.details.from).toBe(WorkPhase.PLANNING);
    expect(event.details.to).toBe(WorkPhase.ENRICHMENT);
  });
});
