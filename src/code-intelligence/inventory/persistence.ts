/**
 * `JsonInventoryPersistence` — durability layer for the M3 lightweight code
 * inventory (ADR-017 D1).
 *
 * Two storage tiers, deliberately asymmetric:
 *
 *   1. **JSON canonical** (`.monsthera/cache/code-index.json`). The
 *      authoritative read surface. Writes are guarded by `proper-lockfile`
 *      via `withFileLock` so concurrent agents can't tear the file. Atomic
 *      replace through a `*.tmp` sibling means a crash mid-write leaves
 *      the previous good copy intact.
 *
 *   2. **Optional Dolt mirror** (`code_artifacts`, `code_relations`). Best
 *      effort, write-only from M3's perspective. When `doltClient` is
 *      `null`, the mirror is a no-op. When the mirror call fails — Dolt
 *      down, schema mismatch, transient connectivity error — we log a
 *      warning and proceed; the JSON write is what matters. ADR-014's
 *      portable-workspace rule says everything must work without Dolt,
 *      and the asymmetry here is what makes that promise true.
 *
 * The class is intentionally small: it doesn't know about extraction,
 * file walking, or query semantics. It only knows how to read and write
 * a `CodeInventorySnapshot`. The service layer composes it with the
 * extractor and the in-memory revalidation map.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { StorageError } from "../../core/errors.js";
import { withFileLock } from "../../core/file-lock.js";
import type { Logger } from "../../core/logger.js";
import type { Result } from "../../core/result.js";
import { err, ok } from "../../core/result.js";

import type {
  CodeInventoryFileEntry,
  CodeInventorySnapshot,
} from "./types.js";

/**
 * Slim structural type for the Dolt write surface used by the mirror.
 *
 * The production wiring (Phase 3) will pass a thin adapter around
 * `mysql2`'s `Pool`. Tests pass an in-memory stub that records every
 * SQL call without dragging mysql2 into the test bundle. Keeping the
 * interface tiny — one method, no result shapes — means stubs stay
 * trivial and the boundary doesn't drift as the schema evolves.
 */
export interface DoltMirrorClient {
  /** Execute a single DDL or DML statement. May throw on failure. */
  execute(sql: string, params?: ReadonlyArray<string | number | null>): Promise<void>;
}

export interface JsonInventoryPersistenceOptions {
  /**
   * Absolute path to the JSON cache file. The conventional location is
   * `<repoPath>/.monsthera/cache/code-index.json`; the service is
   * responsible for resolving it. Persistence treats this as opaque.
   */
  readonly cacheFile: string;
  readonly logger: Logger;
  /**
   * `null` when Dolt is disabled or unavailable — the persistence layer
   * skips the mirror silently.
   */
  readonly doltClient: DoltMirrorClient | null;
}

interface PersistedShape {
  readonly schemaVersion: number;
  readonly builtAt: string;
  readonly repoFingerprint: string;
  readonly files: readonly CodeInventoryFileEntry[];
}

const CURRENT_SCHEMA_VERSION = 1;

/**
 * Persistence handle for one inventory cache file. Construct one per
 * service instance; cheap to make, no hidden state beyond the configured
 * paths and the (optional) mirror client.
 */
export class JsonInventoryPersistence {
  constructor(private readonly options: JsonInventoryPersistenceOptions) {}

  get cacheFile(): string {
    return this.options.cacheFile;
  }

  /**
   * Load the snapshot from disk. Returns `null` (not an error) when the
   * cache file does not exist — that signals "first run, build needed",
   * which is a normal state, not a failure.
   *
   * Returns `StorageError` only for real I/O / schema problems.
   */
  async load(): Promise<Result<CodeInventorySnapshot | null, StorageError>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.options.cacheFile, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return ok(null);
      }
      return err(
        new StorageError(`Failed to read inventory cache: ${this.options.cacheFile}`, {
          cause: String(error),
        }),
      );
    }

    let parsed: PersistedShape;
    try {
      parsed = JSON.parse(raw) as PersistedShape;
    } catch (error) {
      return err(
        new StorageError(`Inventory cache is not valid JSON: ${this.options.cacheFile}`, {
          cause: String(error),
        }),
      );
    }

    if (parsed.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      // Older snapshots are quietly discarded so the next build refreshes
      // them. Erroring here would block agents on a recoverable mismatch.
      this.options.logger.warn(
        "Inventory cache schema version mismatch; treating as missing",
        { found: parsed.schemaVersion, expected: CURRENT_SCHEMA_VERSION },
      );
      return ok(null);
    }
    if (!Array.isArray(parsed.files)) {
      return err(
        new StorageError(`Inventory cache is missing the files array`, {
          cacheFile: this.options.cacheFile,
        }),
      );
    }

    return ok({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      builtAt: parsed.builtAt,
      repoFingerprint: parsed.repoFingerprint,
      files: parsed.files,
    });
  }

  /**
   * Persist a snapshot. JSON is written first (under a lockfile, atomic
   * via tmp+rename); Dolt mirror runs after. A Dolt mirror failure does
   * NOT fail the call — we log and return ok with `degraded` info on the
   * caller's side. The caller (the service) decides whether to surface
   * "degraded" upward.
   *
   * Returns the snapshot itself on success, with a `degraded` flag added
   * by the service layer when needed; the persistence layer just reports
   * mirror outcomes via the resolved Result and the optional warning log.
   */
  async save(
    snapshot: CodeInventorySnapshot,
  ): Promise<Result<{ readonly mirrorDegraded?: { reason: string } }, StorageError>> {
    if (snapshot.schemaVersion !== CURRENT_SCHEMA_VERSION) {
      return err(
        new StorageError("Refusing to write snapshot with unknown schemaVersion", {
          got: snapshot.schemaVersion,
          expected: CURRENT_SCHEMA_VERSION,
        }),
      );
    }

    const writeResult = await this.writeJson(snapshot);
    if (!writeResult.ok) return writeResult;

    if (!this.options.doltClient) {
      // No Dolt configured — that's fine, we're done.
      return ok({});
    }

    try {
      await this.mirrorToDolt(snapshot, this.options.doltClient);
      return ok({});
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.options.logger.warn(
        "Dolt inventory mirror failed; JSON cache is canonical, continuing",
        { error: reason },
      );
      return ok({ mirrorDegraded: { reason } });
    }
  }

  /** Drop the cache file (used by `reindex({ full: true })`). */
  async clear(): Promise<Result<void, StorageError>> {
    try {
      await fs.rm(this.options.cacheFile, { force: true });
      return ok(undefined);
    } catch (error) {
      return err(
        new StorageError(`Failed to clear inventory cache: ${this.options.cacheFile}`, {
          cause: String(error),
        }),
      );
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private async writeJson(
    snapshot: CodeInventorySnapshot,
  ): Promise<Result<void, StorageError>> {
    await fs.mkdir(path.dirname(this.options.cacheFile), { recursive: true });
    const tmpPath = `${this.options.cacheFile}.tmp`;

    const serialized = JSON.stringify(snapshot, null, 2);

    return withFileLock<void, StorageError>(this.options.cacheFile, async () => {
      try {
        // Write to a sibling tmp first, then rename. On POSIX `rename` is
        // atomic within the same filesystem — readers see either the old
        // file or the new file, never a partial write. Windows' rename
        // is also atomic for files in the same directory under modern
        // Node (since fs.promises.rename uses MoveFileExW with REPLACE).
        await fs.writeFile(tmpPath, serialized, "utf-8");
        await fs.rename(tmpPath, this.options.cacheFile);
        return ok(undefined);
      } catch (error) {
        // Clean up the tmp file if rename failed mid-flight.
        await fs.rm(tmpPath, { force: true }).catch(() => undefined);
        return err(
          new StorageError(`Failed to write inventory cache: ${this.options.cacheFile}`, {
            cause: String(error),
          }),
        );
      }
    });
  }

  /**
   * Replace `code_artifacts` and `code_relations` rows for the snapshot.
   *
   * Strategy: full wipe + bulk insert. M3 doesn't need incremental Dolt
   * writes — the JSON cache is the read surface, and the inventory is
   * cheap enough to re-mirror on every save. Keeping the mirror code
   * trivially correct beats optimizing a code path nothing reads from.
   *
   * Throws on failure. The caller (`save`) catches and degrades.
   */
  private async mirrorToDolt(
    snapshot: CodeInventorySnapshot,
    client: DoltMirrorClient,
  ): Promise<void> {
    await client.execute("DELETE FROM code_relations");
    await client.execute("DELETE FROM code_artifacts");

    for (const file of snapshot.files) {
      const fileArtifactId = `file:${file.path}`;
      await client.execute(
        `INSERT INTO code_artifacts
         (id, kind, name, path, language, start_line, end_line, exported, scope, stale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fileArtifactId,
          "file",
          path.basename(file.path),
          file.path,
          file.language ?? null,
          null,
          null,
          null,
          null,
          0,
        ],
      );

      for (const symbol of file.symbols) {
        await client.execute(
          `INSERT INTO code_artifacts
           (id, kind, name, path, language, start_line, end_line, exported, scope, stale)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            symbol.id,
            symbol.kind,
            symbol.name,
            symbol.path,
            symbol.language ?? file.language ?? null,
            symbol.startLine ?? null,
            symbol.endLine ?? null,
            symbol.exported === undefined ? null : symbol.exported ? 1 : 0,
            symbol.scope ?? null,
            symbol.stale ? 1 : 0,
          ],
        );

        // M3 only emits `contains` edges (file → symbol). M4 will add
        // `imports` and `references` between symbols across files.
        await client.execute(
          `INSERT INTO code_relations (source_id, target_id, kind, confidence)
           VALUES (?, ?, ?, ?)`,
          [fileArtifactId, symbol.id, "contains", "high"],
        );
      }
    }
  }
}
