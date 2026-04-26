import * as fs from "node:fs/promises";
import * as path from "node:path";
import { defaultConfig, loadConfig } from "../core/config.js";
import { DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILE, VERSION } from "../core/constants.js";
import { StorageError, ValidationError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import {
  CURRENT_WORKSPACE_SCHEMA_VERSION,
  ensureWorkspaceManifest,
  loadWorkspaceManifest,
  manifestPath,
  type WorkspaceManifest,
} from "./manifest.js";

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

export async function migrateWorkspace(repoPath: string): Promise<Result<{ manifest: WorkspaceManifest; created: boolean }, StorageError | ValidationError>> {
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
  return ok(result.value);
}

export async function backupWorkspace(repoPath: string): Promise<Result<WorkspaceBackup, StorageError | ValidationError>> {
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
