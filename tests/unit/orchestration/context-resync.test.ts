import { beforeEach, describe, expect, it } from "vitest";
import { ResyncMonitor } from "../../../src/orchestration/resync-monitor.js";
import { InMemoryOrchestrationEventRepository } from "../../../src/orchestration/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { InMemorySnapshotRepository } from "../../../src/context/snapshot-in-memory-repository.js";
import { SnapshotService } from "../../../src/context/snapshot-service.js";
import { createLogger } from "../../../src/core/logger.js";
import {
  Priority,
  WorkTemplate,
  agentId,
  workId as toWorkId,
} from "../../../src/core/types.js";
import type {
  AgentLifecycleDetails,
  AgentNeedsResyncEventDetails,
  ContextDriftEventDetails,
} from "../../../src/orchestration/types.js";

/**
 * ResyncMonitor (ADR-009): observes agent_started events, ticks at the
 * configured cadence, emits context_drift_detected on each tick where
 * the snapshot has moved, and escalates to agent_needs_resync once the
 * agent has been running for 2× the interval without a closing event.
 */
describe("ResyncMonitor", () => {
  const INTERVAL = 60_000; // 1 minute, smallest the monitor accepts.

  let eventRepo: InMemoryOrchestrationEventRepository;
  let snapshotRepo: InMemorySnapshotRepository;
  let snapshotService: SnapshotService;
  let workRepo: InMemoryWorkArticleRepository;
  let nowMs = 0;
  let monitor: ResyncMonitor;

  beforeEach(async () => {
    eventRepo = new InMemoryOrchestrationEventRepository();
    nowMs = Date.now();
    snapshotRepo = new InMemorySnapshotRepository({ now: () => nowMs });
    workRepo = new InMemoryWorkArticleRepository();
    // nowMs anchored above so the snapshot repo's clock is set early;
    // the snapshot repo and the monitor share `nowMs` for `capturedAt`
    // and rehydration windowing respectively.
    snapshotService = new SnapshotService({
      repo: snapshotRepo,
      logger: createLogger({ level: "error", domain: "test" }),
      maxAgeMinutes: 30,
      now: () => nowMs,
    });
    monitor = new ResyncMonitor({
      eventRepo,
      snapshotService,
      workRepo,
      logger: createLogger({ level: "error", domain: "test" }),
      intervalMs: INTERVAL,
      now: () => nowMs,
      // No scheduler — tests drive `tick()` directly.
    });
    // Seed a work article every test needs.
    const article = await workRepo.create({
      title: "Resync target",
      template: WorkTemplate.FEATURE,
      priority: Priority.MEDIUM,
      author: agentId("author"),
      content: "## Objective\nDo it.\n\n## Acceptance Criteria\n- ok",
    });
    if (!article.ok) throw new Error(article.error.message);
  });

  async function recordSnapshot(_idHint: string, agent: string, work: string): Promise<string> {
    // Note: the snapshot repo assigns its own id and capturedAt — caller
    // hints are stripped by the input validator. Returns the generated id
    // so the caller can assert on it.
    const result = await snapshotService.record({
      agentId: agent,
      workId: work,
      cwd: "/tmp/x",
      gitRef: { sha: "abc", branch: "main", dirty: false },
      files: [],
      runtimes: { node: "22" },
      packageManagers: ["pnpm"],
      lockfiles: [],
    });
    if (!result.ok) throw new Error(result.error.message);
    return result.value.id;
  }

  async function emitAgentStarted(agent: string, work: string): Promise<void> {
    const details: AgentLifecycleDetails = {
      role: "implementer",
      transition: { from: "enrichment", to: "implementation" },
    };
    const logged = await eventRepo.logEvent({
      workId: toWorkId(work),
      eventType: "agent_started",
      agentId: agentId(agent),
      details: details as unknown as Record<string, unknown>,
    });
    if (!logged.ok) throw new Error(logged.error.message);
    await monitor.onEvent(logged.value);
  }

  it("starts tracking on agent_started when a snapshot is present", async () => {
    const articles = await workRepo.findActive();
    if (!articles.ok) throw new Error(articles.error.message);
    const work = articles.value[0]!.id;
    await recordSnapshot("v1", "agent-a", work);
    await emitAgentStarted("agent-a", work);
    expect(monitor.trackedCount).toBe(1);
  });

  it("does not track when no snapshot exists at start time", async () => {
    const articles = await workRepo.findActive();
    if (!articles.ok) throw new Error(articles.error.message);
    const work = articles.value[0]!.id;
    await emitAgentStarted("agent-a", work);
    expect(monitor.trackedCount).toBe(0);
  });

  it("emits context_drift_detected when the snapshot moves before 2× interval", async () => {
    const articles = await workRepo.findActive();
    if (!articles.ok) throw new Error(articles.error.message);
    const work = articles.value[0]!.id;
    const originalId = await recordSnapshot("v1", "agent-a", work);
    await emitAgentStarted("agent-a", work);

    // Advance one interval and record a fresh snapshot — drift signal.
    nowMs += INTERVAL;
    const newerId = await recordSnapshot("v2", "agent-a", work);
    await monitor.tick();

    const drift = await eventRepo.findByType("context_drift_detected");
    if (!drift.ok) throw new Error(drift.error.message);
    expect(drift.value).toHaveLength(1);
    const details = drift.value[0]!.details as unknown as ContextDriftEventDetails;
    expect(details.originalSnapshotId).toBe(originalId);
    expect(details.currentSnapshotId).toBe(newerId);
    expect(monitor.trackedCount).toBe(1); // observational — does not untrack.
  });

  it("does not emit drift when the snapshot has not moved", async () => {
    const articles = await workRepo.findActive();
    if (!articles.ok) throw new Error(articles.error.message);
    const work = articles.value[0]!.id;
    await recordSnapshot("v1", "agent-a", work);
    await emitAgentStarted("agent-a", work);

    nowMs += INTERVAL;
    await monitor.tick();

    const drift = await eventRepo.findByType("context_drift_detected");
    if (!drift.ok) throw new Error(drift.error.message);
    expect(drift.value).toHaveLength(0);
  });

  it("escalates to agent_needs_resync after 2× interval", async () => {
    const articles = await workRepo.findActive();
    if (!articles.ok) throw new Error(articles.error.message);
    const work = articles.value[0]!.id;
    await recordSnapshot("v1", "agent-a", work);
    await emitAgentStarted("agent-a", work);

    // Cross the 2× boundary.
    nowMs += INTERVAL * 2 + 1;
    await monitor.tick();

    const resync = await eventRepo.findByType("agent_needs_resync");
    if (!resync.ok) throw new Error(resync.error.message);
    expect(resync.value).toHaveLength(1);
    const details = resync.value[0]!.details as unknown as AgentNeedsResyncEventDetails;
    expect(details.role).toBe("implementer");
    expect(details.contextPackSummary.guidance.some((g) => g.includes("FRESH"))).toBe(true);
    expect(monitor.trackedCount).toBe(0); // escalation untracks.
  });

  it("clears tracking on agent_completed", async () => {
    const articles = await workRepo.findActive();
    if (!articles.ok) throw new Error(articles.error.message);
    const work = articles.value[0]!.id;
    await recordSnapshot("v1", "agent-a", work);
    await emitAgentStarted("agent-a", work);
    expect(monitor.trackedCount).toBe(1);

    const closeDetails: AgentLifecycleDetails = {
      role: "implementer",
      transition: { from: "enrichment", to: "implementation" },
    };
    const completed = await eventRepo.logEvent({
      workId: toWorkId(work),
      eventType: "agent_completed",
      agentId: agentId("agent-a"),
      details: closeDetails as unknown as Record<string, unknown>,
    });
    if (!completed.ok) throw new Error(completed.error.message);
    await monitor.onEvent(completed.value);
    expect(monitor.trackedCount).toBe(0);
  });

  it("clears tracking on agent_failed", async () => {
    const articles = await workRepo.findActive();
    if (!articles.ok) throw new Error(articles.error.message);
    const work = articles.value[0]!.id;
    await recordSnapshot("v1", "agent-a", work);
    await emitAgentStarted("agent-a", work);

    const failed = await eventRepo.logEvent({
      workId: toWorkId(work),
      eventType: "agent_failed",
      agentId: agentId("agent-a"),
      details: { role: "implementer", transition: { from: "enrichment", to: "implementation" }, error: "boom" } as unknown as Record<string, unknown>,
    });
    if (!failed.ok) throw new Error(failed.error.message);
    await monitor.onEvent(failed.value);
    expect(monitor.trackedCount).toBe(0);
  });

  it("rehydrates open agent_started events on start()", async () => {
    const articles = await workRepo.findActive();
    if (!articles.ok) throw new Error(articles.error.message);
    const work = articles.value[0]!.id;
    await recordSnapshot("v1", "agent-a", work);

    // Pre-populate event repo with an open agent_started — no monitor wiring yet.
    const startedDetails: AgentLifecycleDetails = {
      role: "implementer",
      transition: { from: "enrichment", to: "implementation" },
    };
    const logged = await eventRepo.logEvent({
      workId: toWorkId(work),
      eventType: "agent_started",
      agentId: agentId("agent-a"),
      details: startedDetails as unknown as Record<string, unknown>,
    });
    if (!logged.ok) throw new Error(logged.error.message);

    // Build a fresh monitor (cold start) and verify rehydration.
    const fresh = new ResyncMonitor({
      eventRepo,
      snapshotService,
      workRepo,
      logger: createLogger({ level: "error", domain: "test" }),
      intervalMs: INTERVAL,
      now: () => nowMs,
    });
    await fresh.start();
    try {
      expect(fresh.trackedCount).toBe(1);
    } finally {
      fresh.stop();
    }
  });

  it("does not rehydrate agent_started older than 4× interval", async () => {
    const articles = await workRepo.findActive();
    if (!articles.ok) throw new Error(articles.error.message);
    const work = articles.value[0]!.id;
    await recordSnapshot("v1", "agent-a", work);

    // Backdate the agent_started event past the rehydration window.
    const startedDetails: AgentLifecycleDetails = {
      role: "implementer",
      transition: { from: "enrichment", to: "implementation" },
    };
    const oldEvent = await eventRepo.logEvent({
      workId: toWorkId(work),
      eventType: "agent_started",
      agentId: agentId("agent-a"),
      details: startedDetails as unknown as Record<string, unknown>,
    });
    if (!oldEvent.ok) throw new Error(oldEvent.error.message);

    // Move the clock 5× interval into the future so the existing event
    // falls outside the 4× rehydration window.
    nowMs += INTERVAL * 5;

    const fresh = new ResyncMonitor({
      eventRepo,
      snapshotService,
      workRepo,
      logger: createLogger({ level: "error", domain: "test" }),
      intervalMs: INTERVAL,
      now: () => nowMs,
    });
    await fresh.start();
    try {
      expect(fresh.trackedCount).toBe(0);
    } finally {
      fresh.stop();
    }
  });
});
