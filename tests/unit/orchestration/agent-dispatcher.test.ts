import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { AgentDispatcher } from "../../../src/orchestration/agent-dispatcher.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { InMemoryOrchestrationEventRepository } from "../../../src/orchestration/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { WorkPhase, WorkTemplate, Priority, agentId, workId } from "../../../src/core/types.js";
import type { GuardFailure } from "../../../src/orchestration/types.js";

async function setup(opts?: { dedupWindowMs?: number; worktreePath?: string }) {
  const workRepo = new InMemoryWorkArticleRepository();
  const eventRepo = new InMemoryOrchestrationEventRepository();
  const logger = createLogger({ level: "error", domain: "test" });
  const dispatcher = new AgentDispatcher({
    workRepo,
    eventRepo,
    logger,
    ...(opts?.dedupWindowMs !== undefined ? { dedupWindowMs: opts.dedupWindowMs } : {}),
    ...(opts?.worktreePath !== undefined ? { worktreePath: opts.worktreePath } : {}),
  });
  return { workRepo, eventRepo, dispatcher };
}

async function seedFeatureWith(
  workRepo: InMemoryWorkArticleRepository,
  enrichment: Array<{ role: string; status: "pending" | "contributed" | "skipped" }>,
) {
  const result = await workRepo.create({
    title: "Feature with enrichment",
    template: WorkTemplate.FEATURE,
    priority: Priority.MEDIUM,
    author: agentId("author"),
    content: "## Objective\nDo it.\n\n## Acceptance Criteria\nWorks.",
    enrichmentRoles: enrichment.map((e) => ({
      role: e.role,
      agentId: agentId(`${e.role}-agent`),
      status: e.status,
    })),
  });
  if (!result.ok) throw new Error(result.error.message);
  const advance = await workRepo.advancePhase(result.value.id, WorkPhase.ENRICHMENT);
  if (!advance.ok) throw new Error(advance.error.message);
  return advance.value;
}

describe("AgentDispatcher: min_enrichment_met → agent_needed per pending role", () => {
  it("emits one event per pending role", async () => {
    const { workRepo, eventRepo, dispatcher } = await setup();
    const article = await seedFeatureWith(workRepo, [
      { role: "architecture", status: "pending" },
      { role: "security", status: "pending" },
    ]);
    const failure: GuardFailure = {
      workId: article.id,
      transition: { from: WorkPhase.ENRICHMENT, to: WorkPhase.IMPLEMENTATION },
      failed: [{ name: "min_enrichment_met", passed: false }],
    };

    const requests = await dispatcher.dispatchFor([failure]);
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => r.deduped === false)).toBe(true);
    expect(requests.map((r) => r.role).sort()).toEqual(["architecture", "security"]);
    expect(requests.every((r) => r.reason === "template_enrichment")).toBe(true);

    const events = await eventRepo.findByWorkId(workId(article.id));
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const needed = events.value.filter((e) => e.eventType === "agent_needed");
    expect(needed).toHaveLength(2);
    for (const event of needed) {
      const details = event.details as Record<string, unknown>;
      expect(details.reason).toBe("template_enrichment");
      expect((details.triggeredBy as Record<string, unknown>).guardName).toBe("min_enrichment_met");
      expect((details.transition as Record<string, unknown>).from).toBe("enrichment");
      expect((details.transition as Record<string, unknown>).to).toBe("implementation");
    }
  });

  it("skips already-contributed and skipped roles", async () => {
    const { workRepo, dispatcher } = await setup();
    const article = await seedFeatureWith(workRepo, [
      { role: "architecture", status: "contributed" },
      { role: "security", status: "pending" },
      { role: "performance", status: "skipped" },
    ]);
    const failure: GuardFailure = {
      workId: article.id,
      transition: { from: WorkPhase.ENRICHMENT, to: WorkPhase.IMPLEMENTATION },
      failed: [{ name: "min_enrichment_met", passed: false }],
    };
    const requests = await dispatcher.dispatchFor([failure]);
    expect(requests.map((r) => r.role)).toEqual(["security"]);
  });

  it("ignores content-shape guards (has_objective etc.)", async () => {
    const { workRepo, dispatcher } = await setup();
    const article = await seedFeatureWith(workRepo, [{ role: "architecture", status: "pending" }]);
    const failure: GuardFailure = {
      workId: article.id,
      transition: { from: WorkPhase.PLANNING, to: WorkPhase.ENRICHMENT },
      failed: [{ name: "has_acceptance_criteria", passed: false }],
    };
    const requests = await dispatcher.dispatchFor([failure]);
    expect(requests).toHaveLength(0);
  });
});

describe("AgentDispatcher: dedup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT re-emit when an open agent_needed exists in window", async () => {
    const { workRepo, eventRepo, dispatcher } = await setup({ dedupWindowMs: 60_000 });
    const article = await seedFeatureWith(workRepo, [{ role: "architecture", status: "pending" }]);
    const failure: GuardFailure = {
      workId: article.id,
      transition: { from: WorkPhase.ENRICHMENT, to: WorkPhase.IMPLEMENTATION },
      failed: [{ name: "min_enrichment_met", passed: false }],
    };

    const first = await dispatcher.dispatchFor([failure]);
    expect(first[0]!.deduped).toBe(false);

    // Advance time within the window — should dedup.
    vi.advanceTimersByTime(30_000);
    const second = await dispatcher.dispatchFor([failure]);
    expect(second[0]!.deduped).toBe(true);

    const events = await eventRepo.findByType("agent_needed");
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value).toHaveLength(1);
  });

  it("re-emits after the dedup window elapses", async () => {
    const { workRepo, eventRepo, dispatcher } = await setup({ dedupWindowMs: 60_000 });
    const article = await seedFeatureWith(workRepo, [{ role: "architecture", status: "pending" }]);
    const failure: GuardFailure = {
      workId: article.id,
      transition: { from: WorkPhase.ENRICHMENT, to: WorkPhase.IMPLEMENTATION },
      failed: [{ name: "min_enrichment_met", passed: false }],
    };
    await dispatcher.dispatchFor([failure]);

    // Advance past the window.
    vi.advanceTimersByTime(120_000);
    const second = await dispatcher.dispatchFor([failure]);
    expect(second[0]!.deduped).toBe(false);

    const events = await eventRepo.findByType("agent_needed");
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value).toHaveLength(2);
  });

  it("dedupWindowMs=0 disables dedup", async () => {
    const { workRepo, eventRepo, dispatcher } = await setup({ dedupWindowMs: 0 });
    const article = await seedFeatureWith(workRepo, [{ role: "architecture", status: "pending" }]);
    const failure: GuardFailure = {
      workId: article.id,
      transition: { from: WorkPhase.ENRICHMENT, to: WorkPhase.IMPLEMENTATION },
      failed: [{ name: "min_enrichment_met", passed: false }],
    };
    await dispatcher.dispatchFor([failure]);
    await dispatcher.dispatchFor([failure]);
    const events = await eventRepo.findByType("agent_needed");
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    expect(events.value).toHaveLength(2);
  });
});

/**
 * Regression test (Codex review of S3 commit 4): when an article has
 * multiple pending reviewers, `all_reviewers_approved` produces N slots
 * sharing `(workId, role="reviewer", transition)`. The pre-loop dedup
 * snapshot must be reused across the N slots so each one emits — if the
 * snapshot is reloaded inside the slot loop, the second reviewer dedupes
 * against the first reviewer's just-emitted event and gets dropped.
 */
describe("AgentDispatcher: per-target dedup snapshot semantics", () => {
  it("emits one event per pending reviewer in a single dispatch pass", async () => {
    const { workRepo, eventRepo, dispatcher } = await setup({ dedupWindowMs: 60 * 60 * 1000 });
    const created = await workRepo.create({
      title: "Article needing multiple reviewers",
      template: WorkTemplate.FEATURE,
      priority: Priority.MEDIUM,
      author: agentId("author"),
      content:
        "## Objective\nx\n\n## Acceptance Criteria\n- ok\n\n## Implementation\n- y",
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("a"), status: "contributed" },
      ],
      reviewers: [
        { agentId: agentId("rev-1"), status: "pending" },
        { agentId: agentId("rev-2"), status: "pending" },
        { agentId: agentId("rev-3"), status: "pending" },
      ],
    });
    if (!created.ok) throw new Error(created.error.message);
    for (const phase of [
      WorkPhase.ENRICHMENT,
      WorkPhase.IMPLEMENTATION,
      WorkPhase.REVIEW,
    ]) {
      const r = await workRepo.advancePhase(created.value.id, phase);
      if (!r.ok) throw new Error(`advance → ${phase}: ${r.error.message}`);
    }

    const failure: GuardFailure = {
      workId: created.value.id,
      transition: { from: WorkPhase.REVIEW, to: WorkPhase.DONE },
      failed: [{ name: "all_reviewers_approved", passed: false }],
    };

    const requests = await dispatcher.dispatchFor([failure]);
    // Three pending reviewers → three reviewer_missing slots, none deduped
    // against each other within the same dispatch pass.
    expect(requests.filter((r) => r.role === "reviewer")).toHaveLength(3);
    expect(requests.every((r) => r.deduped === false)).toBe(true);

    // Three persisted agent_needed events on this article.
    const events = await eventRepo.findByWorkId(workId(created.value.id));
    expect(events.ok).toBe(true);
    if (!events.ok) return;
    const reviewerEvents = events.value.filter((e) => {
      if (e.eventType !== "agent_needed") return false;
      const d = e.details as Record<string, unknown>;
      return (d.role as string) === "reviewer";
    });
    expect(reviewerEvents).toHaveLength(3);
  });
});
