import { ConfigurationError } from "../core/errors.js";
import type { StorageError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import type { WorkspaceManifest } from "./manifest.js";

/**
 * A workspace schema migration transforms a manifest (and optionally
 * touches files under the workspace) from `fromVersion` to
 * `fromVersion + 1`. Migrations are pure with respect to logical
 * intent — same input always produces same output — but ARE allowed
 * filesystem side-effects since some schema bumps require moving
 * directories or rewriting files.
 *
 * Contract:
 *   - `from` must equal the migration's `fromVersion`.
 *   - The returned manifest must have `workspaceSchemaVersion ===
 *     fromVersion + 1`.
 *   - On error the workspace must be left in a state that the same
 *     migration can re-run (idempotent recovery).
 */
export interface WorkspaceMigration {
  readonly fromVersion: number;
  readonly description: string;
  readonly run: (
    manifest: WorkspaceManifest,
    repoPath: string,
  ) => Promise<Result<WorkspaceManifest, StorageError | ConfigurationError>>;
}

/**
 * Registry of known migrations, keyed by `fromVersion`. Add new entries
 * here when bumping `CURRENT_WORKSPACE_SCHEMA_VERSION`.
 *
 * The registry is intentionally exported so tests can mutate it under a
 * controlled `beforeEach`/`afterEach` to validate the runner without
 * shipping a real migration. Production code should treat it as
 * append-only.
 */
export const WORKSPACE_MIGRATIONS: Record<number, WorkspaceMigration> = {};

/**
 * Run every registered migration that takes the manifest from `from` up
 * to `to`. Returns the final manifest, or the first error a migration
 * surfaced.
 *
 * `from === to` is a no-op. `from > to` is a programming error and
 * surfaces a ConfigurationError.
 */
export async function runMigrations(
  manifest: WorkspaceManifest,
  repoPath: string,
  to: number,
  registry: Record<number, WorkspaceMigration> = WORKSPACE_MIGRATIONS,
): Promise<Result<WorkspaceManifest, StorageError | ConfigurationError>> {
  const from = manifest.workspaceSchemaVersion;
  if (from === to) return ok(manifest);
  if (from > to) {
    return err(
      new ConfigurationError(
        `Workspace schema is at version ${from}, newer than the supported ${to}; migration would downgrade`,
        { from, to },
      ),
    );
  }

  let current = manifest;
  for (let v = from; v < to; v++) {
    const migration = registry[v];
    if (!migration) {
      return err(
        new ConfigurationError(
          `No migration registered to advance workspace schema from v${v} to v${v + 1}`,
          { from: v, to: v + 1 },
        ),
      );
    }
    const result = await migration.run(current, repoPath);
    if (!result.ok) return result;
    if (result.value.workspaceSchemaVersion !== v + 1) {
      return err(
        new ConfigurationError(
          `Migration ${migration.description} did not advance schema version (expected v${v + 1}, got v${result.value.workspaceSchemaVersion})`,
          { from: v, expected: v + 1, actual: result.value.workspaceSchemaVersion },
        ),
      );
    }
    current = result.value;
  }
  return ok(current);
}
