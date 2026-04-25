import { workId, timestamp } from "../core/types.js";
import type { AgentId } from "../core/types.js";
import type { Logger } from "../core/logger.js";
import type { WorkArticle, WorkArticleRepository } from "../work/repository.js";
import type { SnapshotService } from "../context/snapshot-service.js";
import type {
  OrchestrationEvent,
  OrchestrationEventRepository,
} from "./repository.js";
import type {
  AgentContextPackSummary,
  AgentLifecycleDetails,
  AgentNeedsResyncEventDetails,
  ContextDriftEventDetails,
} from "./types.js";

const DEFAULT_INTERVAL_MS = 10 * 60_000; // 10 minutes
const DEFAULT_STALE_MULTIPLIER = 2;
const REHYDRATION_AGE_MULTIPLIER = 4;

export interface ResyncMonitorDeps {
  readonly eventRepo: OrchestrationEventRepository;
  readonly snapshotService: SnapshotService;
  readonly workRepo: WorkArticleRepository;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly staleMultiplier?: number;
  readonly now?: () => number;
  readonly scheduler?: ResyncScheduler;
  readonly worktreePath?: string;
}

/** Minimal scheduler interface — `setInterval`-compatible. */
export interface ResyncScheduler {
  schedule(callback: () => void, intervalMs: number): ScheduledHandle;
}

export interface ScheduledHandle {
  cancel(): void;
}

interface TrackedAgent {
  readonly workId: string;
  readonly agentId: string;
  readonly role: string;
  readonly originalSnapshotId: string;
  readonly startedAt: number;
}

/**
 * Resync monitor (ADR-009): observes `agent_started` events, ticks at a
 * configurable cadence, and emits two new event types as drift accumulates:
 *
 *   - `context_drift_detected` — observational; the agent's snapshot is
 *     no longer the latest. Fires every tick where drift is present and
 *     the agent hasn't been running too long.
 *   - `agent_needs_resync` — dispatch-like; the agent has been running
 *     past `2 × intervalMs` without a closing event. Carries
 *     `contextPackSummary` + `guidance[]` so the harness can re-spawn
 *     with fresh context or cancel. The agent is removed from tracking
 *     after this event fires.
 *
 * The "original snapshot" is captured the moment the monitor observes
 * `agent_started` (no change to AgentLifecycleDetails — keeps ADR-008's
 * harness contract intact). Cold-start: rehydrates from the event log,
 * scoped to events younger than `intervalMs * 4`.
 */
export class ResyncMonitor {
  private readonly eventRepo: OrchestrationEventRepository;
  private readonly snapshotService: SnapshotService;
  private readonly workRepo: WorkArticleRepository;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly staleMultiplier: number;
  private readonly now: () => number;
  private readonly scheduler?: ResyncScheduler;
  private readonly worktreePath?: string;
  private readonly tracked = new Map<string, TrackedAgent>();
  private handle?: ScheduledHandle;
  private nodeTimer?: ReturnType<typeof setInterval>;

  constructor(deps: ResyncMonitorDeps) {
    this.eventRepo = deps.eventRepo;
    this.snapshotService = deps.snapshotService;
    this.workRepo = deps.workRepo;
    this.logger = deps.logger.child({ domain: "resync-monitor" });
    this.intervalMs = Math.max(60_000, deps.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.staleMultiplier = Math.max(1, deps.staleMultiplier ?? DEFAULT_STALE_MULTIPLIER);
    this.now = deps.now ?? (() => Date.now());
    this.scheduler = deps.scheduler;
    this.worktreePath = deps.worktreePath?.trim() ? deps.worktreePath : undefined;
  }

  /** Number of currently-tracked agents. Surfaced for tests + status. */
  get trackedCount(): number {
    return this.tracked.size;
  }

  async start(): Promise<void> {
    await this.rehydrate();
    if (this.handle || this.nodeTimer) return;
    const fire = () => {
      void this.tick().catch((e) => {
        this.logger.error("Resync tick failed", {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    };
    if (this.scheduler) {
      this.handle = this.scheduler.schedule(fire, this.intervalMs);
    } else {
      this.nodeTimer = setInterval(fire, this.intervalMs);
      this.nodeTimer.unref?.();
    }
    this.logger.info("Resync monitor started", {
      intervalMs: this.intervalMs,
      tracked: this.tracked.size,
    });
  }

  stop(): void {
    if (this.handle) {
      this.handle.cancel();
      this.handle = undefined;
    }
    if (this.nodeTimer) {
      clearInterval(this.nodeTimer);
      this.nodeTimer = undefined;
    }
  }

  async onEvent(event: OrchestrationEvent): Promise<void> {
    switch (event.eventType) {
      case "agent_started":
        await this.onAgentStarted(event);
        return;
      case "agent_completed":
      case "agent_failed":
        this.untrack(event);
        return;
      default:
        return;
    }
  }

  /** Public for tests so they can drive the monitor without real timers. */
  async tick(): Promise<void> {
    const now = this.now();
    // Snapshot keys before iterating so escalations can mutate the map.
    const entries = Array.from(this.tracked.values());
    for (const entry of entries) {
      const ageMs = now - entry.startedAt;
      if (ageMs >= this.staleMultiplier * this.intervalMs) {
        await this.escalateResync(entry, ageMs);
        this.tracked.delete(this.keyFor(entry.workId, entry.agentId));
        continue;
      }
      await this.detectDrift(entry, ageMs);
    }
  }

  private async onAgentStarted(event: OrchestrationEvent): Promise<void> {
    const aid = event.agentId;
    if (!aid) {
      this.logger.warn("agent_started without agentId; cannot track for resync", {
        workId: event.workId,
      });
      return;
    }
    const details = event.details as Partial<AgentLifecycleDetails> | undefined;
    const role = details?.role;
    if (!role) {
      this.logger.warn("agent_started without role in details; cannot track for resync", {
        workId: event.workId,
        agentId: aid,
      });
      return;
    }
    const snapshotResult = await this.snapshotService.getLatest({
      workId: event.workId,
      agentId: aid,
    });
    if (!snapshotResult.ok || !snapshotResult.value) {
      this.logger.debug("No snapshot at agent_started; skipping resync tracking", {
        workId: event.workId,
        agentId: aid,
        snapshotLookupOk: snapshotResult.ok,
      });
      return;
    }
    const startedAtMs = new Date(event.createdAt).getTime();
    this.tracked.set(this.keyFor(event.workId, aid), {
      workId: event.workId,
      agentId: aid,
      role,
      originalSnapshotId: snapshotResult.value.snapshot.id,
      startedAt: Number.isFinite(startedAtMs) ? startedAtMs : this.now(),
    });
  }

  private untrack(event: OrchestrationEvent): void {
    const aid = event.agentId;
    if (!aid) return;
    this.tracked.delete(this.keyFor(event.workId, aid));
  }

  private async detectDrift(entry: TrackedAgent, ageMs: number): Promise<void> {
    const latestResult = await this.snapshotService.getLatest({
      workId: entry.workId,
      agentId: entry.agentId,
    });
    if (!latestResult.ok || !latestResult.value) return;
    const latest = latestResult.value.snapshot;
    if (latest.id === entry.originalSnapshotId) return;

    const driftDetails: ContextDriftEventDetails = {
      role: entry.role,
      originalSnapshotId: entry.originalSnapshotId,
      currentSnapshotId: latest.id,
      ageMinutes: Math.floor(ageMs / 60_000),
      checkedAt: timestamp(),
    };
    const logged = await this.eventRepo.logEvent({
      workId: workId(entry.workId),
      eventType: "context_drift_detected",
      agentId: this.toAgentId(entry.agentId),
      details: driftDetails as unknown as Record<string, unknown>,
    });
    if (!logged.ok) {
      this.logger.warn("Failed to persist context_drift_detected", {
        workId: entry.workId,
        agentId: entry.agentId,
        error: logged.error.message,
      });
    }
  }

  private async escalateResync(entry: TrackedAgent, ageMs: number): Promise<void> {
    const latestResult = await this.snapshotService.getLatest({
      workId: entry.workId,
      agentId: entry.agentId,
    });
    const currentSnapshotId =
      latestResult.ok && latestResult.value ? latestResult.value.snapshot.id : entry.originalSnapshotId;
    const articleResult = await this.workRepo.findById(entry.workId);
    if (!articleResult.ok) {
      this.logger.warn("Cannot emit agent_needs_resync; work article not found", {
        workId: entry.workId,
        error: articleResult.error.message,
      });
      return;
    }
    const article = articleResult.value;
    const ageMinutes = Math.floor(ageMs / 60_000);

    const details: AgentNeedsResyncEventDetails = {
      role: entry.role,
      originalSnapshotId: entry.originalSnapshotId,
      currentSnapshotId,
      ageMinutes,
      contextPackSummary: this.buildResyncContextPack(article, entry, ageMinutes, currentSnapshotId),
      requestedAt: timestamp(),
    };
    const logged = await this.eventRepo.logEvent({
      workId: workId(entry.workId),
      eventType: "agent_needs_resync",
      agentId: this.toAgentId(entry.agentId),
      details: details as unknown as Record<string, unknown>,
    });
    if (!logged.ok) {
      this.logger.warn("Failed to persist agent_needs_resync", {
        workId: entry.workId,
        agentId: entry.agentId,
        error: logged.error.message,
      });
    }
  }

  private buildResyncContextPack(
    article: WorkArticle,
    entry: TrackedAgent,
    ageMinutes: number,
    currentSnapshotId: string,
  ): AgentContextPackSummary {
    const cdLine = this.worktreePath
      ? `cd ${this.worktreePath} && pwd # safe-parallel-dispatch invariant from ADR-012`
      : "cd <target-worktree> && pwd # safe-parallel-dispatch invariant from ADR-012";
    const guidance: string[] = [
      `Read FRESH context pack: build_context_pack({ work_id: "${entry.workId}", query: "${entry.workId}" })`,
      cdLine,
      `Acting as ${entry.role}, decide: re-spawn agent ${entry.agentId} with the fresh pack, or cancel the in-flight work.`,
      `Drift summary: agent ran ${ageMinutes} min; snapshot moved from ${entry.originalSnapshotId} → ${currentSnapshotId}.`,
    ];
    return {
      workArticleSlug: article.id,
      relatedKnowledgeSlugs: [...article.references],
      codeRefs: [...article.codeRefs],
      guidance,
    };
  }

  private async rehydrate(): Promise<void> {
    const startedResult = await this.eventRepo.findByType("agent_started");
    if (!startedResult.ok) {
      this.logger.warn("Failed to load agent_started events for rehydration; cold start", {
        error: startedResult.error.message,
      });
      return;
    }
    const completedResult = await this.eventRepo.findByType("agent_completed");
    const failedResult = await this.eventRepo.findByType("agent_failed");
    const closed = new Set<string>();
    if (completedResult.ok) {
      for (const e of completedResult.value) {
        if (e.agentId) closed.add(this.keyFor(e.workId, e.agentId));
      }
    }
    if (failedResult.ok) {
      for (const e of failedResult.value) {
        if (e.agentId) closed.add(this.keyFor(e.workId, e.agentId));
      }
    }

    const cutoff = this.now() - this.intervalMs * REHYDRATION_AGE_MULTIPLIER;
    let rehydrated = 0;
    for (const event of startedResult.value) {
      if (!event.agentId) continue;
      const key = this.keyFor(event.workId, event.agentId);
      if (closed.has(key)) continue;
      const startedAtMs = new Date(event.createdAt).getTime();
      if (!Number.isFinite(startedAtMs) || startedAtMs < cutoff) continue;
      await this.onAgentStarted(event);
      rehydrated += 1;
    }
    if (rehydrated > 0) {
      this.logger.info("Rehydrated resync tracking from event log", { rehydrated });
    }
  }

  private keyFor(workIdValue: string, agentIdValue: string): string {
    return `${workIdValue}::${agentIdValue}`;
  }

  private toAgentId(value: string): AgentId {
    return value as AgentId;
  }
}

/**
 * Read the resync interval from env var `MONSTHERA_RESYNC_INTERVAL_MS`.
 * Falls back to the 10-minute default. Sub-minute values are rejected
 * so a malformed env can't degenerate the monitor into a busy loop.
 */
export function readResyncIntervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MONSTHERA_RESYNC_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 60_000) return DEFAULT_INTERVAL_MS;
  return parsed;
}
