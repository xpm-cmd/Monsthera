import { ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import { generateId, timestamp } from "../core/types.js";
import { NotFoundError } from "../core/errors.js";
import type { StorageError } from "../core/errors.js";
import type { EnvironmentSnapshot, RecordSnapshotInput } from "./snapshot-schema.js";
import type { SnapshotRepository } from "./snapshot-repository.js";

/**
 * Bounded in-memory snapshot store. Snapshots are small but unbounded callers
 * (noisy agents, test loops) could exhaust memory; cap at MAX_SNAPSHOTS and
 * evict oldest-first once the cap is reached.
 */
export class InMemorySnapshotRepository implements SnapshotRepository {
  private static readonly MAX_SNAPSHOTS = 5_000;
  private snapshots: EnvironmentSnapshot[] = [];

  async record(input: RecordSnapshotInput): Promise<Result<EnvironmentSnapshot, StorageError>> {
    if (this.snapshots.length >= InMemorySnapshotRepository.MAX_SNAPSHOTS) {
      const keep = Math.floor(InMemorySnapshotRepository.MAX_SNAPSHOTS * 0.9);
      this.snapshots = this.snapshots.slice(-keep);
    }

    const stored: EnvironmentSnapshot = {
      ...input,
      id: generateId("s"),
      capturedAt: timestamp(),
    };
    this.snapshots.push(stored);
    return ok(stored);
  }

  async findById(id: string): Promise<Result<EnvironmentSnapshot, NotFoundError | StorageError>> {
    const found = this.snapshots.find((s) => s.id === id);
    if (!found) return { ok: false, error: new NotFoundError("snapshot", id) };
    return ok(found);
  }

  async findLatestByAgent(agentId: string): Promise<Result<EnvironmentSnapshot | null, StorageError>> {
    const matching = this.snapshots.filter((s) => s.agentId === agentId);
    if (matching.length === 0) return ok(null);
    const latest = matching.reduce((acc, cur) => (cur.capturedAt > acc.capturedAt ? cur : acc));
    return ok(latest);
  }

  async findLatestByWork(workId: string): Promise<Result<EnvironmentSnapshot | null, StorageError>> {
    const matching = this.snapshots.filter((s) => s.workId === workId);
    if (matching.length === 0) return ok(null);
    const latest = matching.reduce((acc, cur) => (cur.capturedAt > acc.capturedAt ? cur : acc));
    return ok(latest);
  }

  async findAllByWork(workId: string): Promise<Result<readonly EnvironmentSnapshot[], StorageError>> {
    const matching = this.snapshots
      .filter((s) => s.workId === workId)
      .slice()
      .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    return ok(matching);
  }
}
