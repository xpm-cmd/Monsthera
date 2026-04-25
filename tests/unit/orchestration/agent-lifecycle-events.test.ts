import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgentDispatcher } from "../../../src/orchestration/agent-dispatcher.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { InMemoryOrchestrationEventRepository } from "../../../src/orchestration/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { WorkPhase, WorkTemplate, Priority, agentId, workId } from "../../../src/core/types.js";
import type { GuardFailure } from "../../../src/orchestration/types.js";

/**
 * Lifecycle dedup contract: an `agent_needed` is "open" until a later
 * `agent_started` / `agent_completed` / `agent_failed` closes the slot.
 * Once closed, the next failure pass MUST re-emit even inside the dedup
 * window — the previous request's lifecycle has run to completion.
 */
describe("agent lifecycle dedup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-25T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setup() {
    const workRepo = new InMemoryWorkArticleRepository();
    const eventRepo = new InMemoryOrchestrationEventRepository();
    const logger = createLogger({ level: "error", domain: "test" });
    const dispatcher = new AgentDispatcher({
      workRepo,
      eventRepo,
      logger,
      dedupWindowMs: 60 * 60 * 1000,
    });
    const created = await workRepo.create({
      title: "Lifecycle test",
      template: WorkTemplate.FEATURE,
      priority: Priority.MEDIUM,
      author: agentId("author"),
      content: "## Objective\nDo it.\n\n## Acceptance Criteria\nWorks.",
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("arch-agent"), status: "pending" },
      ],
    });
    if (!created.ok) throw new Error(created.error.message);
    const advanced = await workRepo.advancePhase(created.value.id, WorkPhase.ENRICHMENT);
    if (!advanced.ok) throw new Error(advanced.error.message);
    return { workRepo, eventRepo, dispatcher, article: advanced.value };
  }

  function failureFor(article: { id: string }): GuardFailure {
    return {
      workId: article.id,
      transition: { from: WorkPhase.ENRICHMENT, to: WorkPhase.IMPLEMENTATION },
      failed: [{ name: "min_enrichment_met", passed: false }],
    };
  }

  it("agent_completed closes the slot — next dispatch re-emits", async () => {
    const { eventRepo, dispatcher, article } = await setup();
    await dispatcher.dispatchFor([failureFor(article)]);

    vi.advanceTimersByTime(5_000);
    await eventRepo.logEvent({
      workId: workId(article.id),
      eventType: "agent_completed",
      details: {
        role: "architecture",
        transition: { from: WorkPhase.ENRICHMENT, to: WorkPhase.IMPLEMENTATION },
      },
    });

    vi.advanceTimersByTime(5_000);
    const second = await dispatcher.dispatchFor([failureFor(article)]);
    expect(second[0]!.deduped).toBe(false);

    const allNeeded = await eventRepo.findByType("agent_needed");
    if (!allNeeded.ok) throw new Error(allNeeded.error.message);
    expect(allNeeded.value).toHaveLength(2);
  });

  it("agent_failed also closes the slot — caller can retry", async () => {
    const { eventRepo, dispatcher, article } = await setup();
    await dispatcher.dispatchFor([failureFor(article)]);

    vi.advanceTimersByTime(5_000);
    await eventRepo.logEvent({
      workId: workId(article.id),
      eventType: "agent_failed",
      details: {
        role: "architecture",
        transition: { from: WorkPhase.ENRICHMENT, to: WorkPhase.IMPLEMENTATION },
        error: "tool crashed",
      },
    });

    vi.advanceTimersByTime(5_000);
    const second = await dispatcher.dispatchFor([failureFor(article)]);
    expect(second[0]!.deduped).toBe(false);
  });

  it("agent_started DOES close the slot — already in progress means not idle", async () => {
    // Design choice: once a harness picks up the request, dedup releases —
    // because if the harness then crashes, the next failure pass should
    // re-emit. The window-based fallback would re-emit after the window
    // anyway, but explicit closure on `agent_started` is both more
    // responsive and easier to reason about for the harness.
    const { eventRepo, dispatcher, article } = await setup();
    await dispatcher.dispatchFor([failureFor(article)]);

    vi.advanceTimersByTime(5_000);
    await eventRepo.logEvent({
      workId: workId(article.id),
      eventType: "agent_started",
      details: {
        role: "architecture",
        transition: { from: WorkPhase.ENRICHMENT, to: WorkPhase.IMPLEMENTATION },
      },
    });

    vi.advanceTimersByTime(5_000);
    const second = await dispatcher.dispatchFor([failureFor(article)]);
    expect(second[0]!.deduped).toBe(false);
  });

  it("dedupes for an unrelated role on the same article", async () => {
    // The two roles get independent dedup state — emitting a slot for
    // architecture must not suppress a future security request.
    const { workRepo, eventRepo, dispatcher, article } = await setup();
    // Re-seed: add a second pending role.
    const updated = await workRepo.contributeEnrichment(article.id, "architecture", "skipped");
    if (!updated.ok) throw new Error(updated.error.message);
    // Now article still needs an enrichment for `min_enrichment_met` in
    // some sense; for this test we directly construct the failure with
    // both roles still pending by re-seeding via a fresh article.
    const created = await workRepo.create({
      title: "Two roles",
      template: WorkTemplate.FEATURE,
      priority: Priority.MEDIUM,
      author: agentId("author"),
      content: "## Objective\nDo it.\n\n## Acceptance Criteria\nWorks.",
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("arch"), status: "pending" },
        { role: "security", agentId: agentId("sec"), status: "pending" },
      ],
    });
    if (!created.ok) throw new Error(created.error.message);
    await workRepo.advancePhase(created.value.id, WorkPhase.ENRICHMENT);
    const failure: GuardFailure = {
      workId: created.value.id,
      transition: { from: WorkPhase.ENRICHMENT, to: WorkPhase.IMPLEMENTATION },
      failed: [{ name: "min_enrichment_met", passed: false }],
    };
    await dispatcher.dispatchFor([failure]);

    const events = await eventRepo.findByWorkId(workId(created.value.id));
    if (!events.ok) throw new Error(events.error.message);
    const needed = events.value.filter((e) => e.eventType === "agent_needed");
    expect(needed).toHaveLength(2);
    expect(needed.map((e) => (e.details as { role: string }).role).sort()).toEqual(["architecture", "security"]);
  });
});
