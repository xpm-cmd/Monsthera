import * as fs from "node:fs/promises";
import * as path from "node:path";
import { defaultConfig, loadConfig } from "../core/config.js";
import { DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILE, VERSION } from "../core/constants.js";
import { StorageError, ValidationError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import { inspectManagedProcess, type ManagedProcessKind } from "../ops/process-registry.js";
import {
  CURRENT_WORKSPACE_SCHEMA_VERSION,
  ensureWorkspaceManifest,
  loadWorkspaceManifest,
  manifestPath,
  writeWorkspaceManifest,
  type WorkspaceManifest,
} from "./manifest.js";
import { runMigrations, WORKSPACE_MIGRATIONS, type WorkspaceMigration } from "./migrations.js";

const QUIESCED_KINDS: readonly ManagedProcessKind[] = ["dolt"];

/**
 * Refuse to back up or restore a workspace while a managed process is still
 * running with trusted metadata. Dolt holds memory-mapped files in
 * `.monsthera/dolt/` and a filesystem-level copy/replace of that directory
 * while the daemon is alive captures or installs an inconsistent snapshot.
 *
 * Callers that intend to coordinate the daemon themselves (e.g.
 * `executeSelfUpdate` already stops Dolt before invoking these operations)
 * see no error because the inspection reports `running: false` after the
 * stop.
 */
async function ensureManagedProcessesQuiesced(
  repoPath: string,
  operation: "backup" | "restore",
): Promise<Result<void, StorageError | ValidationError>> {
  for (const kind of QUIESCED_KINDS) {
    const status = await inspectManagedProcess(repoPath, kind);
    if (!status.ok) return status;
    if (status.value.running && status.value.trusted) {
      return err(
        new ValidationError(
          `Refusing to ${operation} workspace while managed ${kind} process is running (pid ${status.value.pid}). ` +
            `Stop it first with "monsthera self restart ${kind}" or restart the daemon after operating, ` +
            `then retry.`,
          { kind, pid: status.value.pid, operation },
        ),
      );
    }
  }
  return ok(undefined);
}

export interface WorkspaceStatus {
  readonly repoPath: string;
  readonly schema: {
    readonly current: number;
    readonly workspace: number | null;
    readonly compatible: boolean;
    readonly manifestExists: boolean;
  };
  readonly version: {
    readonly current: string;
    readonly createdBy?: string;
    readonly lastOpenedBy?: string;
  };
  readonly paths: {
    readonly manifest: string;
    readonly config: string;
    readonly knowledgeRoot: string;
    readonly doltDataDir: string;
    readonly backupRoot: string;
  };
  readonly config: {
    readonly valid: boolean;
    readonly error?: string;
  };
}

export interface WorkspaceBackup {
  readonly id: string;
  readonly path: string;
  readonly createdAt: string;
  readonly included: string[];
  readonly skipped: string[];
}

export interface WorkspaceRestore {
  readonly backupId: string;
  readonly restored: string[];
  readonly skipped: string[];
}

export async function inspectWorkspace(repoPath: string): Promise<Result<WorkspaceStatus, StorageError>> {
  const resolvedRepo = path.resolve(repoPath);
  const configResult = loadConfig(resolvedRepo);
  const config = configResult.ok ? configResult.value : defaultConfig(resolvedRepo);
  const manifestResult = await loadWorkspaceManifest(resolvedRepo);
  if (!manifestResult.ok) {
    return err(new StorageError(manifestResult.error.message, manifestResult.error.details));
  }

  const manifest = manifestResult.value;
  const knowledgeRoot = manifest?.portableData.knowledgeRoot ?? config.storage.markdownRoot;
  const doltDataDir = manifest?.portableData.doltDataDir ?? path.join(DEFAULT_CONFIG_DIR, "dolt");
  const workspaceSchema = manifest?.workspaceSchemaVersion ?? null;

  return ok({
    repoPath: resolvedRepo,
    schema: {
      current: CURRENT_WORKSPACE_SCHEMA_VERSION,
      workspace: workspaceSchema,
      compatible: workspaceSchema === null || workspaceSchema <= CURRENT_WORKSPACE_SCHEMA_VERSION,
      manifestExists: manifest !== null,
    },
    version: {
      current: VERSION,
      createdBy: manifest?.createdBy,
      lastOpenedBy: manifest?.lastOpenedBy,
    },
    paths: {
      manifest: manifestPath(resolvedRepo),
      config: path.join(resolvedRepo, DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILE),
      knowledgeRoot: path.resolve(resolvedRepo, knowledgeRoot),
      doltDataDir: path.resolve(resolvedRepo, doltDataDir),
      backupRoot: path.join(resolvedRepo, DEFAULT_CONFIG_DIR, "backups"),
    },
    config: {
      valid: configResult.ok,
      error: configResult.ok ? undefined : configResult.error.message,
    },
  });
}

export async function migrateWorkspace(
  repoPath: string,
  options: { readonly migrations?: Record<number, WorkspaceMigration> } = {},
): Promise<Result<{ manifest: WorkspaceManifest; created: boolean }, StorageError | ValidationError>> {
  const resolvedRepo = path.resolve(repoPath);
  const configResult = loadConfig(resolvedRepo);
  const config = configResult.ok ? configResult.value : defaultConfig(resolvedRepo);
  const result = await ensureWorkspaceManifest(resolvedRepo, {
    knowledgeRoot: config.storage.markdownRoot,
    doltDataDir: path.join(DEFAULT_CONFIG_DIR, "dolt"),
  });
  if (!result.ok) {
    return err(new StorageError(result.error.message, result.error.details));
  }
  if (result.value.manifest.workspaceSchemaVersion > CURRENT_WORKSPACE_SCHEMA_VERSION) {
    return err(
      new ValidationError("Workspace schema is newer than this Monsthera version", {
        workspaceSchemaVersion: result.value.manifest.workspaceSchemaVersion,
        supportedSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
      }),
    );
  }

  // Run any registered migrations needed to bring this workspace up to
  // the version supported by the running binary. v1 → v1 is a no-op
  // because no migrations are registered yet, but the runner is in
  // place so future schema bumps can ship a migration alongside the
  // version constant change rather than as a follow-up.
  if (result.value.manifest.workspaceSchemaVersion < CURRENT_WORKSPACE_SCHEMA_VERSION) {
    const migrated = await runMigrations(
      result.value.manifest,
      resolvedRepo,
      CURRENT_WORKSPACE_SCHEMA_VERSION,
      options.migrations ?? WORKSPACE_MIGRATIONS,
    );
    if (!migrated.ok) {
      return err(new StorageError(migrated.error.message, migrated.error.details));
    }
    const persisted = await writeWorkspaceManifest(resolvedRepo, migrated.value);
    if (!persisted.ok) return persisted;
    return ok({ manifest: persisted.value, created: result.value.created });
  }

  return ok(result.value);
}

export async function backupWorkspace(repoPath: string): Promise<Result<WorkspaceBackup, StorageError | ValidationError>> {
  const quiesced = await ensureManagedProcessesQuiesced(repoPath, "backup");
  if (!quiesced.ok) return quiesced;

  const migrated = await migrateWorkspace(repoPath);
  if (!migrated.ok) return migrated;

  const status = await inspectWorkspace(repoPath);
  if (!status.ok) return status;

  const createdAt = new Date().toISOString();
  const id = `backup-${createdAt.replace(/[:.]/g, "-")}`;
  const backupRoot = status.value.paths.backupRoot;
  const backupPath = path.join(backupRoot, id);
  const included: string[] = [];
  const skipped: string[] = [];

  try {
    await fs.mkdir(backupRoot, { recursive: true });
    await fs.mkdir(backupPath, { recursive: false });
    await copyIfExists(status.value.paths.knowledgeRoot, path.join(backupPath, "knowledge"), included, skipped, "knowledge");
    await copyIfExists(status.value.paths.config, path.join(backupPath, DEFAULT_CONFIG_FILE), included, skipped, DEFAULT_CONFIG_FILE);
    await copyIfExists(status.value.paths.manifest, path.join(backupPath, "manifest.json"), included, skipped, "manifest.json");
    await copyIfExists(status.value.paths.doltDataDir, path.join(backupPath, "dolt"), included, skipped, "dolt");

    const metadata = {
      id,
      createdAt,
      createdBy: VERSION,
      sourceRepoPath: status.value.repoPath,
      workspaceSchemaVersion: migrated.value.manifest.workspaceSchemaVersion,
      portableData: migrated.value.manifest.portableData,
      included,
      skipped,
    };
    await fs.writeFile(path.join(backupPath, "backup-manifest.json"), JSON.stringify(metadata, null, 2) + "\n", "utf-8");

    return ok({ id, path: backupPath, createdAt, included, skipped });
  } catch (error) {
    return err(new StorageError(`Failed to create workspace backup: ${backupPath}`, { cause: String(error) }));
  }
}

export async function restoreWorkspace(
  repoPath: string,
  backupPathInput: string,
  options: { readonly force?: boolean } = {},
): Promise<Result<WorkspaceRestore, StorageError | ValidationError>> {
  if (!options.force) {
    return err(new ValidationError("workspace restore requires --force to overwrite local workspace files"));
  }

  const quiesced = await ensureManagedProcessesQuiesced(repoPath, "restore");
  if (!quiesced.ok) return quiesced;

  const resolvedRepo = path.resolve(repoPath);
  const backupPath = path.resolve(backupPathInput);
  const metadataPath = path.join(backupPath, "backup-manifest.json");
  let metadata: { readonly id?: unknown; readonly portableData?: { readonly knowledgeRoot?: unknown; readonly doltDataDir?: unknown } };
  try {
    metadata = JSON.parse(await fs.readFile(metadataPath, "utf-8")) as typeof metadata;
  } catch (error) {
    return err(new StorageError(`Failed to read backup manifest: ${metadataPath}`, { cause: String(error) }));
  }

  const backupId = typeof metadata.id === "string" ? metadata.id : path.basename(backupPath);
  const knowledgeRoot = typeof metadata.portableData?.knowledgeRoot === "string" ? metadata.portableData.knowledgeRoot : "knowledge";
  const doltDataDir = typeof metadata.portableData?.doltDataDir === "string" ? metadata.portableData.doltDataDir : path.join(DEFAULT_CONFIG_DIR, "dolt");
  const restored: string[] = [];
  const skipped: string[] = [];

  try {
    await restoreIfExists(path.join(backupPath, "knowledge"), path.resolve(resolvedRepo, knowledgeRoot), restored, skipped, "knowledge");
    await restoreIfExists(path.join(backupPath, DEFAULT_CONFIG_FILE), path.join(resolvedRepo, DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILE), restored, skipped, DEFAULT_CONFIG_FILE);
    await restoreIfExists(path.join(backupPath, "manifest.json"), manifestPath(resolvedRepo), restored, skipped, "manifest.json");
    await restoreIfExists(path.join(backupPath, "dolt"), path.resolve(resolvedRepo, doltDataDir), restored, skipped, "dolt");
    return ok({ backupId, restored, skipped });
  } catch (error) {
    return err(new StorageError(`Failed to restore workspace backup: ${backupPath}`, { cause: String(error) }));
  }
}

async function copyIfExists(src: string, dest: string, included: string[], skipped: string[], label: string): Promise<void> {
  try {
    await fs.cp(src, dest, { recursive: true, errorOnExist: true, force: false });
    included.push(label);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      skipped.push(label);
      return;
    }
    throw error;
  }
}

async function restoreIfExists(src: string, dest: string, restored: string[], skipped: string[], label: string): Promise<void> {
  try {
    await fs.access(src);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      skipped.push(label);
      return;
    }
    throw error;
  }
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true });
  restored.push(label);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
