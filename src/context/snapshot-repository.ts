import type { Result } from "../core/result.js";
import type { NotFoundError, StorageError } from "../core/errors.js";
import type { EnvironmentSnapshot, RecordSnapshotInput } from "./snapshot-schema.js";

export interface SnapshotRepository {
  record(input: RecordSnapshotInput): Promise<Result<EnvironmentSnapshot, StorageError>>;
  findById(id: string): Promise<Result<EnvironmentSnapshot, NotFoundError | StorageError>>;
  findLatestByAgent(agentId: string): Promise<Result<EnvironmentSnapshot | null, StorageError>>;
  findLatestByWork(workId: string): Promise<Result<EnvironmentSnapshot | null, StorageError>>;
  /**
   * All snapshots recorded for a given work id, sorted oldest → newest by
   * `capturedAt`. Empty array when none exist. Added in the dashboard
   * snapshot-diff follow-up so callers that want a baseline (earliest) +
   * current (latest) pair can get both in one round-trip.
   */
  findAllByWork(workId: string): Promise<Result<readonly EnvironmentSnapshot[], StorageError>>;
}
