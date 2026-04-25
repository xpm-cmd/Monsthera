import type { Result } from "../core/result.js";
import type { WorkId, AgentId, Timestamp } from "../core/types.js";
import type { StorageError } from "../core/errors.js";

/** Orchestration event types */
export type OrchestrationEventType =
  | "phase_advanced"
  | "agent_spawned"
  | "agent_needed"
  | "agent_started"
  | "agent_completed"
  | "agent_failed"
  | "dependency_blocked"
  | "dependency_resolved"
  | "guard_evaluated"
  | "error_occurred"
  | "context_drift_detected"
  | "agent_needs_resync";

/**
 * Subset of event types that describe the agent-dispatch lifecycle. The
 * dispatcher emits `agent_needed`; an external harness emits the rest. Kept
 * in one place so CLI/MCP validation reuses the same source of truth.
 */
export const AGENT_LIFECYCLE_EVENT_TYPES = [
  "agent_needed",
  "agent_started",
  "agent_completed",
  "agent_failed",
] as const satisfies readonly OrchestrationEventType[];

export type AgentLifecycleEventType = (typeof AGENT_LIFECYCLE_EVENT_TYPES)[number];

/**
 * Full set of event types accepted by `events emit` / `events_emit`. Snapshot
 * of the union as a runtime-iterable Set so validation does not drift if the
 * union grows in unrelated work.
 */
export const VALID_ORCHESTRATION_EVENT_TYPES: ReadonlySet<OrchestrationEventType> = new Set<OrchestrationEventType>([
  "phase_advanced",
  "agent_spawned",
  "agent_needed",
  "agent_started",
  "agent_completed",
  "agent_failed",
  "dependency_blocked",
  "dependency_resolved",
  "guard_evaluated",
  "error_occurred",
  "context_drift_detected",
  "agent_needs_resync",
]);

/**
 * Subset of event types that are emitted internally by Monsthera (the
 * resync monitor) rather than by an external harness via `events emit`.
 * Surfaced here so the CLI/MCP whitelist can reject external attempts to
 * fabricate them — only the resync monitor should produce these.
 */
export const INTERNAL_ONLY_EVENT_TYPES = [
  "context_drift_detected",
  "agent_needs_resync",
] as const satisfies readonly OrchestrationEventType[];

export type InternalOnlyEventType = (typeof INTERNAL_ONLY_EVENT_TYPES)[number];

/** Orchestration event */
export interface OrchestrationEvent {
  readonly id: string;
  readonly workId: WorkId;
  readonly eventType: OrchestrationEventType;
  readonly agentId?: AgentId;
  readonly details: Record<string, unknown>;
  readonly createdAt: Timestamp;
}

/** Orchestration event repository */
export interface OrchestrationEventRepository {
  logEvent(event: Omit<OrchestrationEvent, "id" | "createdAt">): Promise<Result<OrchestrationEvent, StorageError>>;
  findByWorkId(workId: WorkId): Promise<Result<OrchestrationEvent[], StorageError>>;
  findByType(type: OrchestrationEventType): Promise<Result<OrchestrationEvent[], StorageError>>;
  findRecent(limit: number): Promise<Result<OrchestrationEvent[], StorageError>>;
}
