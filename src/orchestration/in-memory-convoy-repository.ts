import { err, ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import {
  AlreadyExistsError,
  NotFoundError,
  StateTransitionError,
  ValidationError,
} from "../core/errors.js";
import type { StorageError } from "../core/errors.js";
import {
  generateConvoyId,
  timestamp,
  workId as toWorkId,
} from "../core/types.js";
import type { ConvoyId, Timestamp, WorkId, WorkPhase } from "../core/types.js";
import type { Convoy } from "./types.js";
import {
  TERMINAL_CONVOY_STATUSES,
  type ConvoyRepository,
  type ConvoyTerminationOptions,
  type CreateConvoyInput,
} from "./convoy-repository.js";

const DEFAULT_TARGET_PHASE: WorkPhase = "implementation";

export class InMemoryConvoyRepository implements ConvoyRepository {
  private readonly convoys = new Map<ConvoyId, Convoy>();

  async create(
    input: CreateConvoyInput,
    createdAt?: Timestamp,
  ): Promise<Result<Convoy, ValidationError | AlreadyExistsError | StorageError>> {
    const validation = validateCreateInput(input);
    if (validation) return err(validation);

    const dedupedMembers = dedupWorkIds(input.memberWorkIds);
    const conflict = this.findActiveMembershipConflict(input.leadWorkId, dedupedMembers);
    if (conflict) return err(conflict);

    const id = generateConvoyId();
    const convoy: Convoy = {
      id,
      leadWorkId: input.leadWorkId,
      memberWorkIds: dedupedMembers,
      goal: input.goal,
      status: "active",
      targetPhase: input.targetPhase ?? DEFAULT_TARGET_PHASE,
      createdAt: createdAt ?? timestamp(),
    };
    this.convoys.set(id, convoy);
    return ok(convoy);
  }

  /**
   * Single-convoy invariant (ADR-010): a work article must not appear as
   * lead or member in two active convoys at the same time. Scans the
   * proposed lead + every deduped member against active convoys; the
   * first hit is reported as `AlreadyExistsError("ConvoyMembership", id)`.
   * Returns `null` when the proposed convoy is conflict-free.
   */
  private findActiveMembershipConflict(
    leadWorkId: WorkId,
    memberWorkIds: readonly WorkId[],
  ): AlreadyExistsError | null {
    const candidates: readonly WorkId[] = [leadWorkId, ...memberWorkIds];
    for (const candidate of candidates) {
      for (const convoy of this.convoys.values()) {
        if (convoy.status !== "active") continue;
        if (
          convoy.leadWorkId === candidate ||
          convoy.memberWorkIds.includes(candidate)
        ) {
          return new AlreadyExistsError("ConvoyMembership", candidate);
        }
      }
    }
    return null;
  }

  async findById(id: ConvoyId): Promise<Result<Convoy, NotFoundError | StorageError>> {
    const found = this.convoys.get(id);
    if (!found) return err(new NotFoundError("Convoy", id));
    return ok(found);
  }

  async findByMember(workId: WorkId): Promise<Result<readonly Convoy[], StorageError>> {
    const matches: Convoy[] = [];
    for (const convoy of this.convoys.values()) {
      if (convoy.leadWorkId === workId || convoy.memberWorkIds.includes(workId)) {
        matches.push(convoy);
      }
    }
    return ok(matches);
  }

  async findActive(): Promise<Result<readonly Convoy[], StorageError>> {
    const active: Convoy[] = [];
    for (const convoy of this.convoys.values()) {
      if (convoy.status === "active") active.push(convoy);
    }
    return ok(active);
  }

  async complete(
    id: ConvoyId,
    options?: ConvoyTerminationOptions,
    completedAt?: Timestamp,
  ): Promise<Result<Convoy, NotFoundError | StateTransitionError | StorageError>> {
    return this.transitionTerminal(id, "completed", options, completedAt);
  }

  async cancel(
    id: ConvoyId,
    options?: ConvoyTerminationOptions,
    completedAt?: Timestamp,
  ): Promise<Result<Convoy, NotFoundError | StateTransitionError | StorageError>> {
    return this.transitionTerminal(id, "cancelled", options, completedAt);
  }

  private transitionTerminal(
    id: ConvoyId,
    target: "completed" | "cancelled",
    _options: ConvoyTerminationOptions | undefined,
    completedAt?: Timestamp,
  ): Result<Convoy, NotFoundError | StateTransitionError | StorageError> {
    const found = this.convoys.get(id);
    if (!found) return err(new NotFoundError("Convoy", id));
    if (TERMINAL_CONVOY_STATUSES.has(found.status)) {
      return err(
        new StateTransitionError(
          found.status,
          target,
          `Convoy "${id}" is already terminal`,
        ),
      );
    }
    const updated: Convoy = {
      ...found,
      status: target,
      completedAt: completedAt ?? timestamp(),
    };
    this.convoys.set(id, updated);
    return ok(updated);
  }
}

function validateCreateInput(input: CreateConvoyInput): ValidationError | null {
  if (!input.goal || input.goal.trim().length === 0) {
    return new ValidationError("Convoy goal must be a non-empty string");
  }
  if (!input.leadWorkId) {
    return new ValidationError("Convoy leadWorkId is required");
  }
  if (input.memberWorkIds.length === 0) {
    return new ValidationError("Convoy must have at least one member");
  }
  if (input.memberWorkIds.some((m) => m === input.leadWorkId)) {
    return new ValidationError("Convoy lead must not also appear in members", {
      leadWorkId: input.leadWorkId,
    });
  }
  return null;
}

function dedupWorkIds(ids: readonly WorkId[]): readonly WorkId[] {
  const seen = new Set<string>();
  const out: WorkId[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(toWorkId(id));
    }
  }
  return out;
}
