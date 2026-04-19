import type { Result } from "../core/result.js";
import type { NotFoundError, StorageError } from "../core/errors.js";
import type { EnvironmentSnapshot, RecordSnapshotInput } from "./snapshot-schema.js";

export interface SnapshotRepository {
  record(input: RecordSnapshotInput): Promise<Result<EnvironmentSnapshot, StorageError>>;
  findById(id: string): Promise<Result<EnvironmentSnapshot, NotFoundError | StorageError>>;
  findLatestByAgent(agentId: string): Promise<Result<EnvironmentSnapshot | null, StorageError>>;
  findLatestByWork(workId: string): Promise<Result<EnvironmentSnapshot | null, StorageError>>;
}
