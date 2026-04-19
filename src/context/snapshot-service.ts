import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import type { Logger } from "../core/logger.js";
import { ValidationError } from "../core/errors.js";
import type { NotFoundError, StorageError } from "../core/errors.js";
import type { EnvironmentSnapshot, SnapshotDiff } from "./snapshot-schema.js";
import { validateRecordSnapshotInput } from "./snapshot-schema.js";
import type { SnapshotRepository } from "./snapshot-repository.js";

export interface SnapshotLookup {
  readonly agentId?: string;
  readonly workId?: string;
}

export interface SnapshotWithAge {
  readonly snapshot: EnvironmentSnapshot;
  readonly ageSeconds: number;
  readonly stale: boolean;
}

export interface SnapshotServiceDeps {
  readonly repo: SnapshotRepository;
  readonly logger: Logger;
  /** Maximum age in minutes before a snapshot is flagged as stale. */
  readonly maxAgeMinutes: number;
  /** Override the wall clock in tests; defaults to Date.now. */
  readonly now?: () => number;
}

export class SnapshotService {
  private readonly repo: SnapshotRepository;
  private readonly logger: Logger;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(deps: SnapshotServiceDeps) {
    this.repo = deps.repo;
    this.logger = deps.logger.child({ domain: "snapshot" });
    this.maxAgeMs = Math.max(0, deps.maxAgeMinutes) * 60_000;
    this.now = deps.now ?? (() => Date.now());
  }

  get maxAgeMinutes(): number {
    return this.maxAgeMs / 60_000;
  }

  async record(
    input: unknown,
  ): Promise<Result<EnvironmentSnapshot, ValidationError | StorageError>> {
    const validated = validateRecordSnapshotInput(input);
    if (!validated.ok) return validated;
    const stored = await this.repo.record(validated.value);
    if (!stored.ok) return stored;
    this.logger.info("Recorded environment snapshot", {
      id: stored.value.id,
      agentId: stored.value.agentId,
      workId: stored.value.workId,
    });
    return ok(stored.value);
  }

  async getLatest(
    lookup: SnapshotLookup,
  ): Promise<Result<SnapshotWithAge | null, ValidationError | StorageError>> {
    if (!lookup.agentId && !lookup.workId) {
      return err(
        new ValidationError(
          "At least one of agentId or workId is required to look up a snapshot",
        ),
      );
    }
    // workId is more specific than agentId when both are provided — prefer it.
    const primary = lookup.workId
      ? await this.repo.findLatestByWork(lookup.workId)
      : await this.repo.findLatestByAgent(lookup.agentId!);
    if (!primary.ok) return primary;
    if (primary.value) return ok(this.decorate(primary.value));

    // Fallback: when workId was asked for but nothing was recorded against it,
    // fall back to the agent's latest snapshot so callers still get context.
    if (lookup.workId && lookup.agentId) {
      const fallback = await this.repo.findLatestByAgent(lookup.agentId);
      if (!fallback.ok) return fallback;
      if (fallback.value) return ok(this.decorate(fallback.value));
    }

    return ok(null);
  }

  async compare(
    leftId: string,
    rightId: string,
  ): Promise<Result<SnapshotDiff, NotFoundError | StorageError>> {
    const leftRes = await this.repo.findById(leftId);
    if (!leftRes.ok) return leftRes;
    const rightRes = await this.repo.findById(rightId);
    if (!rightRes.ok) return rightRes;
    return ok(diffSnapshots(leftRes.value, rightRes.value));
  }

  private decorate(snapshot: EnvironmentSnapshot): SnapshotWithAge {
    const ageMs = Math.max(0, this.now() - new Date(snapshot.capturedAt).getTime());
    const ageSeconds = Math.floor(ageMs / 1000);
    return {
      snapshot,
      ageSeconds,
      stale: this.maxAgeMs > 0 && ageMs > this.maxAgeMs,
    };
  }
}

function diffSnapshots(
  left: EnvironmentSnapshot,
  right: EnvironmentSnapshot,
): SnapshotDiff {
  const leftRuntimes = left.runtimes;
  const rightRuntimes = right.runtimes;
  const allRuntimeKeys = new Set([
    ...Object.keys(leftRuntimes),
    ...Object.keys(rightRuntimes),
  ]);
  const runtimesChanged = [...allRuntimeKeys]
    .filter((k) => leftRuntimes[k] !== rightRuntimes[k])
    .sort();

  const leftLockfiles = new Map(left.lockfiles.map((l) => [l.path, l.sha256]));
  const rightLockfiles = new Map(right.lockfiles.map((l) => [l.path, l.sha256]));
  const allLockPaths = new Set([...leftLockfiles.keys(), ...rightLockfiles.keys()]);
  const lockfilesChanged = [...allLockPaths]
    .filter((p) => leftLockfiles.get(p) !== rightLockfiles.get(p))
    .sort();

  const leftPackageManagers = [...left.packageManagers].sort().join(",");
  const rightPackageManagers = [...right.packageManagers].sort().join(",");

  const ageDeltaMs =
    new Date(right.capturedAt).getTime() - new Date(left.capturedAt).getTime();

  return {
    leftId: left.id,
    rightId: right.id,
    ageDeltaSeconds: Math.floor(ageDeltaMs / 1000),
    cwdChanged: left.cwd !== right.cwd,
    branchChanged: (left.gitRef?.branch ?? null) !== (right.gitRef?.branch ?? null),
    shaChanged: (left.gitRef?.sha ?? null) !== (right.gitRef?.sha ?? null),
    dirtyChanged: (left.gitRef?.dirty ?? null) !== (right.gitRef?.dirty ?? null),
    runtimesChanged,
    packageManagersChanged: leftPackageManagers !== rightPackageManagers,
    lockfilesChanged,
  };
}
