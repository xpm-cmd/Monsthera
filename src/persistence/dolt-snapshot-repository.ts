import type { Pool, RowDataPacket } from "mysql2/promise";
import { ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import { NotFoundError } from "../core/errors.js";
import type { StorageError } from "../core/errors.js";
import { generateId, timestamp } from "../core/types.js";
import type {
  EnvironmentSnapshot,
  RecordSnapshotInput,
  SnapshotGitRef,
  SnapshotLockfile,
} from "../context/snapshot-schema.js";
import type { SnapshotRepository } from "../context/snapshot-repository.js";
import { executeQuery, executeMutation } from "./connection.js";

interface SnapshotRow extends RowDataPacket {
  id: string;
  agent_id: string;
  work_id: string | null;
  cwd: string;
  git_ref: string | Record<string, unknown> | null;
  files: string | unknown[] | null;
  runtimes: string | Record<string, unknown> | null;
  package_managers: string | unknown[] | null;
  lockfiles: string | unknown[] | null;
  memory: string | Record<string, unknown> | null;
  raw: string | null;
  captured_at: string | Date;
}

export class DoltSnapshotRepository implements SnapshotRepository {
  constructor(private readonly pool: Pool) {}

  async record(
    input: RecordSnapshotInput,
  ): Promise<Result<EnvironmentSnapshot, StorageError>> {
    const id = generateId("s");
    const capturedAt = timestamp();
    const stored: EnvironmentSnapshot = {
      ...input,
      id,
      capturedAt,
    };

    const insertSql = `
      INSERT INTO environment_snapshots (
        id, agent_id, work_id, cwd, git_ref, files, runtimes,
        package_managers, lockfiles, memory, raw, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const result = await executeMutation(this.pool, insertSql, [
      stored.id,
      stored.agentId,
      stored.workId ?? null,
      stored.cwd,
      stored.gitRef ? JSON.stringify(stored.gitRef) : null,
      JSON.stringify(stored.files),
      JSON.stringify(stored.runtimes),
      JSON.stringify(stored.packageManagers),
      JSON.stringify(stored.lockfiles),
      stored.memory ? JSON.stringify(stored.memory) : null,
      stored.raw ?? null,
      capturedAt,
    ]);
    if (!result.ok) return result;

    return ok(stored);
  }

  async findById(
    id: string,
  ): Promise<Result<EnvironmentSnapshot, NotFoundError | StorageError>> {
    const queryResult = await executeQuery(
      this.pool,
      "SELECT * FROM environment_snapshots WHERE id = ? LIMIT 1",
      [id],
    );
    if (!queryResult.ok) return queryResult;
    const rows = queryResult.value as SnapshotRow[];
    const row = rows[0];
    if (!row) return { ok: false, error: new NotFoundError("snapshot", id) };
    return ok(this.parseRow(row));
  }

  async findLatestByAgent(
    agentId: string,
  ): Promise<Result<EnvironmentSnapshot | null, StorageError>> {
    const queryResult = await executeQuery(
      this.pool,
      "SELECT * FROM environment_snapshots WHERE agent_id = ? ORDER BY captured_at DESC LIMIT 1",
      [agentId],
    );
    if (!queryResult.ok) return queryResult;
    const rows = queryResult.value as SnapshotRow[];
    if (rows.length === 0) return ok(null);
    return ok(this.parseRow(rows[0]!));
  }

  async findLatestByWork(
    workId: string,
  ): Promise<Result<EnvironmentSnapshot | null, StorageError>> {
    const queryResult = await executeQuery(
      this.pool,
      "SELECT * FROM environment_snapshots WHERE work_id = ? ORDER BY captured_at DESC LIMIT 1",
      [workId],
    );
    if (!queryResult.ok) return queryResult;
    const rows = queryResult.value as SnapshotRow[];
    if (rows.length === 0) return ok(null);
    return ok(this.parseRow(rows[0]!));
  }

  private parseRow(row: SnapshotRow): EnvironmentSnapshot {
    const gitRef = decodeJson<SnapshotGitRef>(row.git_ref);
    const memory = decodeJson<{ totalMb: number; availableMb: number }>(row.memory);
    const files = decodeJson<string[]>(row.files) ?? [];
    const runtimes = decodeJson<Record<string, string>>(row.runtimes) ?? {};
    const packageManagers = decodeJson<string[]>(row.package_managers) ?? [];
    const lockfiles = decodeJson<SnapshotLockfile[]>(row.lockfiles) ?? [];

    const capturedAt = row.captured_at instanceof Date
      ? row.captured_at.toISOString()
      : row.captured_at;

    const snapshot: EnvironmentSnapshot = {
      id: row.id,
      agentId: row.agent_id,
      cwd: row.cwd,
      files,
      runtimes,
      packageManagers,
      lockfiles,
      capturedAt,
    };
    if (row.work_id) snapshot.workId = row.work_id;
    if (gitRef) snapshot.gitRef = gitRef;
    if (memory) snapshot.memory = memory;
    if (row.raw) snapshot.raw = row.raw;
    return snapshot;
  }
}

/**
 * Defensive JSON decoder. The mysql2 driver may hand back JSON columns as
 * already-parsed objects OR as raw strings depending on driver/server mode;
 * null / undefined columns short-circuit to `undefined`.
 */
function decodeJson<T>(value: unknown): T | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    if (value.length === 0) return undefined;
    return JSON.parse(value) as T;
  }
  return value as T;
}
