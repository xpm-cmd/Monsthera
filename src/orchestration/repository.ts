import type { Result } from "../core/result.js";
import type { WorkId, AgentId, Timestamp } from "../core/types.js";
import type { StorageError } from "../core/errors.js";

/** Orchestration event types */
export type OrchestrationEventType =
  | "phase_advanced"
  | "agent_spawned"
  | "agent_completed"
  | "dependency_blocked"
  | "dependency_resolved"
  | "guard_evaluated"
  | "error_occurred";

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
