import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod/v4";
import { DEFAULT_CONFIG_DIR, VERSION } from "../core/constants.js";
import { ConfigurationError, StorageError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";

export const CURRENT_WORKSPACE_SCHEMA_VERSION = 1;
export const WORKSPACE_MANIFEST_FILE = "manifest.json";

const PortableDataSchema = z.object({
  knowledgeRoot: z.string().default("knowledge"),
  doltDataDir: z.string().default(".monsthera/dolt"),
});

const WorkspaceManifestSchema = z.object({
  workspaceSchemaVersion: z.number().int().min(1),
  createdBy: z.string(),
  lastOpenedBy: z.string(),
  portableData: PortableDataSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;

export interface WorkspaceManifestInput {
  readonly knowledgeRoot?: string;
  readonly doltDataDir?: string;
}

export function manifestPath(repoPath: string): string {
  return path.join(repoPath, DEFAULT_CONFIG_DIR, WORKSPACE_MANIFEST_FILE);
}

export async function loadWorkspaceManifest(
  repoPath: string,
): Promise<Result<WorkspaceManifest | null, ConfigurationError | StorageError>> {
  const file = manifestPath(repoPath);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return ok(null);
    return err(new StorageError(`Failed to read workspace manifest: ${file}`, { cause: String(error) }));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return err(new ConfigurationError(`Malformed JSON in workspace manifest: ${file}`, { cause: String(error) }));
  }

  const result = WorkspaceManifestSchema.safeParse(parsed);
  if (!result.success) {
    return err(new ConfigurationError(`Invalid workspace manifest: ${file}`, { issues: result.error.issues }));
  }
  return ok(result.data);
}

export async function writeWorkspaceManifest(
  repoPath: string,
  manifest: WorkspaceManifest,
): Promise<Result<WorkspaceManifest, StorageError>> {
  const file = manifestPath(repoPath);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    return ok(manifest);
  } catch (error) {
    return err(new StorageError(`Failed to write workspace manifest: ${file}`, { cause: String(error) }));
  }
}

export async function ensureWorkspaceManifest(
  repoPath: string,
  input: WorkspaceManifestInput = {},
): Promise<Result<{ manifest: WorkspaceManifest; created: boolean }, ConfigurationError | StorageError>> {
  const existing = await loadWorkspaceManifest(repoPath);
  if (!existing.ok) return existing;

  const now = new Date().toISOString();
  if (existing.value) {
    const updated: WorkspaceManifest = {
      ...existing.value,
      lastOpenedBy: VERSION,
      updatedAt: now,
    };
    const write = await writeWorkspaceManifest(repoPath, updated);
    if (!write.ok) return write;
    return ok({ manifest: write.value, created: false });
  }

  const manifest: WorkspaceManifest = {
    workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
    createdBy: VERSION,
    lastOpenedBy: VERSION,
    portableData: {
      knowledgeRoot: input.knowledgeRoot ?? "knowledge",
      doltDataDir: input.doltDataDir ?? ".monsthera/dolt",
    },
    createdAt: now,
    updatedAt: now,
  };
  const write = await writeWorkspaceManifest(repoPath, manifest);
  if (!write.ok) return write;
  return ok({ manifest: write.value, created: true });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
