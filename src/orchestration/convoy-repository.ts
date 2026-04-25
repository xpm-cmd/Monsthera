import type { Result } from "../core/result.js";
import type { AgentId, ConvoyId, Timestamp, WorkId } from "../core/types.js";
import type {
  AlreadyExistsError,
  NotFoundError,
  StateTransitionError,
  StorageError,
  ValidationError,
} from "../core/errors.js";
import type { Convoy, ConvoyStatus } from "./types.js";

/**
 * Input for `create`. The repository assigns `id`, `status` (always `active`
 * at creation), `createdAt`, and ignores `completedAt`. `targetPhase` falls
 * back to `implementation` when omitted.
 *
 * `actor` is optional because the caller is not always a human-driven agent
 * (the orchestrator can form convoys autonomously). When provided it is
 * propagated to the `convoy_created` provenance event but not persisted on
 * the convoy row itself — see ADR-010 for why provenance lives in events.
 */
export interface CreateConvoyInput {
  readonly leadWorkId: WorkId;
  readonly memberWorkIds: readonly WorkId[];
  readonly goal: string;
  readonly targetPhase?: Convoy["targetPhase"];
  readonly actor?: AgentId;
}

/**
 * Optional metadata attached to terminal transitions (`complete`/`cancel`).
 * Mirrors `actor` on creation: free-text reason and the caller agent id
 * flow into the `convoy_completed` / `convoy_cancelled` events without
 * widening the convoy row.
 */
export interface ConvoyTerminationOptions {
  readonly terminationReason?: string;
  readonly actor?: AgentId;
}

/**
 * Repository for convoys (ADR-009). Convoys are orchestration state — Dolt
 * is the system of record, with no markdown source-of-truth (carve-out from
 * AGENTS.md §4 documented in ADR-009). The in-memory impl exists for tests
 * and for the Dolt-disabled fallback path in `MonstheraContainer`.
 *
 * Lifecycle: a convoy starts `active`, can transition to `completed` (lead
 * reached `targetPhase` and the operator confirmed) or `cancelled` (operator
 * abandoned the grouping). Both are terminal — re-opening would require a
 * new convoy with a fresh id, mirroring how work articles handle terminal
 * phases.
 */
export interface ConvoyRepository {
  create(
    input: CreateConvoyInput,
    createdAt?: Timestamp,
  ): Promise<Result<Convoy, ValidationError | AlreadyExistsError | StorageError>>;
  findById(id: ConvoyId): Promise<Result<Convoy, NotFoundError | StorageError>>;
  findByMember(workId: WorkId): Promise<Result<readonly Convoy[], StorageError>>;
  findActive(): Promise<Result<readonly Convoy[], StorageError>>;
  /** Mark an active convoy as completed. Idempotent re-completion is rejected. */
  complete(
    id: ConvoyId,
    options?: ConvoyTerminationOptions,
    completedAt?: Timestamp,
  ): Promise<Result<Convoy, NotFoundError | StateTransitionError | StorageError>>;
  /** Mark an active convoy as cancelled. Re-cancellation is rejected. */
  cancel(
    id: ConvoyId,
    options?: ConvoyTerminationOptions,
    completedAt?: Timestamp,
  ): Promise<Result<Convoy, NotFoundError | StateTransitionError | StorageError>>;
}

/** Set of statuses that cannot transition out (mirrors the work-article terminal-phase set). */
export const TERMINAL_CONVOY_STATUSES: ReadonlySet<ConvoyStatus> = new Set<ConvoyStatus>(["completed", "cancelled"]);
