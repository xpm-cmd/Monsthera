import type { Pool, RowDataPacket } from "mysql2/promise";
import { err, ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import {
  NotFoundError,
  StateTransitionError,
  ValidationError,
} from "../core/errors.js";
import type { AlreadyExistsError, StorageError } from "../core/errors.js";
import {
  convoyId,
  generateConvoyId,
  timestamp,
  workId,
} from "../core/types.js";
import type { ConvoyId, Timestamp, WorkId, WorkPhase } from "../core/types.js";
import type { Convoy, ConvoyStatus } from "../orchestration/types.js";
import {
  TERMINAL_CONVOY_STATUSES,
  type ConvoyRepository,
  type CreateConvoyInput,
} from "../orchestration/convoy-repository.js";
import { executeMutation, executeQuery } from "./connection.js";

const DEFAULT_TARGET_PHASE: WorkPhase = "implementation";

interface ConvoyRow extends RowDataPacket {
  id: string;
  lead_work_id: string;
  member_work_ids: string | string[];
  goal: string;
  status: string;
  target_phase: string;
  created_at: string;
  completed_at: string | null;
}

export class DoltConvoyRepository implements ConvoyRepository {
  constructor(private readonly pool: Pool) {}

  async create(
    input: CreateConvoyInput,
    createdAt?: Timestamp,
  ): Promise<Result<Convoy, ValidationError | AlreadyExistsError | StorageError>> {
    const validation = validateCreateInput(input);
    if (validation) return err(validation);

    const id = generateConvoyId();
    const now = createdAt ?? timestamp();
    const convoy: Convoy = {
      id,
      leadWorkId: input.leadWorkId,
      memberWorkIds: dedupWorkIds(input.memberWorkIds),
      goal: input.goal,
      status: "active",
      targetPhase: input.targetPhase ?? DEFAULT_TARGET_PHASE,
      createdAt: now,
    };

    const insertResult = await executeMutation(
      this.pool,
      `INSERT INTO convoys
        (id, lead_work_id, member_work_ids, goal, status, target_phase, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        convoy.leadWorkId,
        JSON.stringify(convoy.memberWorkIds),
        convoy.goal,
        convoy.status,
        convoy.targetPhase,
        now,
      ],
    );
    if (!insertResult.ok) return insertResult;
    return ok(convoy);
  }

  async findById(id: ConvoyId): Promise<Result<Convoy, NotFoundError | StorageError>> {
    const result = await executeQuery(
      this.pool,
      "SELECT * FROM convoys WHERE id = ?",
      [id],
    );
    if (!result.ok) return result;
    const rows = result.value as ConvoyRow[];
    if (rows.length === 0) return err(new NotFoundError("Convoy", id));
    return ok(parseRow(rows[0]!));
  }

  async findByMember(memberId: WorkId): Promise<Result<readonly Convoy[], StorageError>> {
    const result = await executeQuery(
      this.pool,
      `SELECT * FROM convoys
        WHERE lead_work_id = ?
           OR JSON_CONTAINS(member_work_ids, JSON_QUOTE(?))
        ORDER BY created_at DESC`,
      [memberId, memberId],
    );
    if (!result.ok) return result;
    const rows = result.value as ConvoyRow[];
    return ok(rows.map(parseRow));
  }

  async findActive(): Promise<Result<readonly Convoy[], StorageError>> {
    const result = await executeQuery(
      this.pool,
      "SELECT * FROM convoys WHERE status = 'active' ORDER BY created_at ASC",
    );
    if (!result.ok) return result;
    const rows = result.value as ConvoyRow[];
    return ok(rows.map(parseRow));
  }

  async complete(
    id: ConvoyId,
    completedAt?: Timestamp,
  ): Promise<Result<Convoy, NotFoundError | StateTransitionError | StorageError>> {
    return this.transitionTerminal(id, "completed", completedAt);
  }

  async cancel(
    id: ConvoyId,
    completedAt?: Timestamp,
  ): Promise<Result<Convoy, NotFoundError | StateTransitionError | StorageError>> {
    return this.transitionTerminal(id, "cancelled", completedAt);
  }

  private async transitionTerminal(
    id: ConvoyId,
    target: "completed" | "cancelled",
    completedAt?: Timestamp,
  ): Promise<Result<Convoy, NotFoundError | StateTransitionError | StorageError>> {
    const existing = await this.findById(id);
    if (!existing.ok) return existing;
    if (TERMINAL_CONVOY_STATUSES.has(existing.value.status)) {
      return err(
        new StateTransitionError(
          existing.value.status,
          target,
          `Convoy "${id}" is already terminal`,
        ),
      );
    }
    const now = completedAt ?? timestamp();
    const updateResult = await executeMutation(
      this.pool,
      "UPDATE convoys SET status = ?, completed_at = ? WHERE id = ?",
      [target, now, id],
    );
    if (!updateResult.ok) return updateResult;
    return ok({ ...existing.value, status: target, completedAt: now });
  }
}

function parseRow(row: ConvoyRow): Convoy {
  const memberJson = typeof row.member_work_ids === "string"
    ? (JSON.parse(row.member_work_ids) as unknown[])
    : (row.member_work_ids as unknown[]);
  const members = Array.isArray(memberJson)
    ? memberJson.map((m) => workId(String(m)))
    : [];
  return {
    id: convoyId(row.id),
    leadWorkId: workId(row.lead_work_id),
    memberWorkIds: members,
    goal: row.goal,
    status: row.status as ConvoyStatus,
    targetPhase: row.target_phase as WorkPhase,
    createdAt: timestamp(row.created_at),
    completedAt: row.completed_at ? timestamp(row.completed_at) : undefined,
  };
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
      out.push(workId(id));
    }
  }
  return out;
}
