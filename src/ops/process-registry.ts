import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_CONFIG_DIR, VERSION } from "../core/constants.js";
import { StorageError, ValidationError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";

const execFileAsync = promisify(execFile);

export const PROCESS_METADATA_SCHEMA_VERSION = 1;

export type ManagedProcessKind = "dolt" | "dashboard";

export interface ManagedProcessMetadata {
  readonly schemaVersion: number;
  readonly kind: ManagedProcessKind;
  readonly pid: number;
  readonly command: string[];
  readonly cwd: string;
  readonly startedAt: string;
  readonly version: string;
  readonly port?: number;
  readonly dataDir?: string;
  readonly logFile?: string;
}

export interface ManagedProcessStatus {
  readonly kind: ManagedProcessKind;
  readonly pid: number | null;
  readonly running: boolean;
  readonly trusted: boolean;
  readonly source: "json" | "legacy-pid" | "missing";
  readonly metadata?: ManagedProcessMetadata;
  readonly reason?: string;
}

export function runDir(repoPath: string): string {
  return path.join(repoPath, DEFAULT_CONFIG_DIR, "run");
}

export function processMetadataPath(repoPath: string, kind: ManagedProcessKind): string {
  return path.join(runDir(repoPath), `${kind}.json`);
}

export function legacyPidPath(repoPath: string, kind: ManagedProcessKind): string {
  return path.join(runDir(repoPath), `${kind}.pid`);
}

export async function writeProcessMetadata(
  repoPath: string,
  metadata: Omit<ManagedProcessMetadata, "schemaVersion" | "version"> & { readonly version?: string },
): Promise<Result<ManagedProcessMetadata, StorageError>> {
  const full: ManagedProcessMetadata = {
    ...metadata,
    schemaVersion: PROCESS_METADATA_SCHEMA_VERSION,
    version: metadata.version ?? VERSION,
  };
  const file = processMetadataPath(repoPath, full.kind);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(full, null, 2) + "\n", "utf-8");
    return ok(full);
  } catch (error) {
    return err(new StorageError(`Failed to write process metadata: ${file}`, { cause: String(error) }));
  }
}

export async function inspectManagedProcess(
  repoPath: string,
  kind: ManagedProcessKind,
): Promise<Result<ManagedProcessStatus, StorageError>> {
  const json = await readJsonMetadata(repoPath, kind);
  if (!json.ok) return json;
  if (json.value) {
    const running = isProcessRunning(json.value.pid);
    const trusted = await validateProcessCommand(json.value);
    return ok({
      kind,
      pid: json.value.pid,
      running,
      trusted: running ? trusted.ok && trusted.value : true,
      source: "json",
      metadata: json.value,
      reason: running && (!trusted.ok || !trusted.value) ? trusted.ok ? "command mismatch" : trusted.error.message : undefined,
    });
  }

  const legacy = await readLegacyPid(repoPath, kind);
  if (!legacy.ok) return legacy;
  if (legacy.value === null) {
    return ok({ kind, pid: null, running: false, trusted: true, source: "missing" });
  }

  return ok({
    kind,
    pid: legacy.value,
    running: isProcessRunning(legacy.value),
    trusted: false,
    source: "legacy-pid",
    reason: "legacy pid file lacks command/cwd metadata",
  });
}

export async function stopManagedProcess(
  repoPath: string,
  kind: ManagedProcessKind,
  options: { readonly force?: boolean } = {},
): Promise<Result<ManagedProcessStatus, StorageError | ValidationError>> {
  const status = await inspectManagedProcess(repoPath, kind);
  if (!status.ok) return status;
  if (!status.value.running || status.value.pid === null) return status;
  if (!status.value.trusted && !options.force) {
    return err(
      new ValidationError(`Refusing to stop ${kind}: process metadata is not trusted`, {
        pid: status.value.pid,
        source: status.value.source,
        reason: status.value.reason,
      }),
    );
  }

  try {
    process.kill(status.value.pid, "SIGTERM");
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      // Process already dead; treat as a clean stop.
      await removeProcessFiles(repoPath, kind);
      return ok({ ...status.value, running: false });
    }
    return err(new StorageError(`Failed to stop ${kind} process`, { pid: status.value.pid, cause: String(error) }));
  }
  await removeProcessFiles(repoPath, kind);
  return ok({ ...status.value, running: false });
}

export async function removeProcessFiles(repoPath: string, kind: ManagedProcessKind): Promise<void> {
  await Promise.all([
    fs.rm(processMetadataPath(repoPath, kind), { force: true }),
    fs.rm(legacyPidPath(repoPath, kind), { force: true }),
  ]);
}

export interface AdoptLegacyResult {
  readonly metadata: ManagedProcessMetadata;
  readonly previousPidFile: string;
}

export async function adoptLegacyPidFile(
  repoPath: string,
  kind: ManagedProcessKind,
): Promise<Result<AdoptLegacyResult, StorageError | ValidationError>> {
  const legacy = await readLegacyPid(repoPath, kind);
  if (!legacy.ok) return legacy;
  if (legacy.value === null) {
    return err(new ValidationError(`No legacy ${kind}.pid file to adopt`));
  }
  const pid = legacy.value;
  if (!isProcessRunning(pid)) {
    await fs.rm(legacyPidPath(repoPath, kind), { force: true });
    return err(
      new ValidationError(`Legacy ${kind}.pid points at a dead process (pid ${pid}); removed stale file`, {
        pid,
        action: "removed",
      }),
    );
  }

  const inspected = await readProcessFromPs(pid);
  if (!inspected.ok) return inspected;

  const metadata = await writeProcessMetadata(repoPath, {
    kind,
    pid,
    command: inspected.value.command,
    cwd: inspected.value.cwd ?? repoPath,
    startedAt: new Date().toISOString(),
  });
  if (!metadata.ok) return metadata;

  await fs.rm(legacyPidPath(repoPath, kind), { force: true });
  return ok({ metadata: metadata.value, previousPidFile: legacyPidPath(repoPath, kind) });
}

export async function cleanupStaleMetadata(
  repoPath: string,
  kind: ManagedProcessKind,
): Promise<Result<{ removed: boolean; source: ManagedProcessStatus["source"] }, StorageError>> {
  const status = await inspectManagedProcess(repoPath, kind);
  if (!status.ok) return status;
  if (status.value.pid === null) return ok({ removed: false, source: status.value.source });
  if (status.value.running) return ok({ removed: false, source: status.value.source });
  await removeProcessFiles(repoPath, kind);
  return ok({ removed: true, source: status.value.source });
}

async function readJsonMetadata(
  repoPath: string,
  kind: ManagedProcessKind,
): Promise<Result<ManagedProcessMetadata | null, StorageError>> {
  const file = processMetadataPath(repoPath, kind);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return ok(null);
    return err(new StorageError(`Failed to read process metadata: ${file}`, { cause: String(error) }));
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ManagedProcessMetadata>;
    if (
      parsed.schemaVersion !== PROCESS_METADATA_SCHEMA_VERSION ||
      parsed.kind !== kind ||
      typeof parsed.pid !== "number" ||
      !Array.isArray(parsed.command) ||
      typeof parsed.cwd !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.version !== "string"
    ) {
      return err(new StorageError(`Invalid process metadata: ${file}`));
    }
    return ok(parsed as ManagedProcessMetadata);
  } catch (error) {
    return err(new StorageError(`Malformed process metadata: ${file}`, { cause: String(error) }));
  }
}

async function readLegacyPid(repoPath: string, kind: ManagedProcessKind): Promise<Result<number | null, StorageError>> {
  const file = legacyPidPath(repoPath, kind);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return ok(null);
    return err(new StorageError(`Failed to read legacy pid file: ${file}`, { cause: String(error) }));
  }
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    return err(new StorageError(`Invalid legacy pid file: ${file}`));
  }
  return ok(pid);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readProcessFromPs(
  pid: number,
): Promise<Result<{ command: string[]; cwd?: string }, StorageError>> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="], {
      timeout: 1000,
      maxBuffer: 64 * 1024,
      encoding: "utf-8",
    });
    const trimmed = stdout.trim();
    if (!trimmed) {
      return err(new StorageError(`ps returned empty command for pid ${pid}`));
    }
    const tokens = trimmed.split(/\s+/);
    return ok({ command: tokens });
  } catch (error) {
    return err(new StorageError(`Failed to inspect process ${pid} via ps`, { cause: String(error) }));
  }
}

/**
 * Validate that `pid` is actually running the command recorded in metadata.
 *
 * Previous implementation used `actual.includes(expected)` plus a basename
 * substring fallback, which was trivially spoofable: any process whose
 * `ps` output happened to contain the basename token (e.g. a script named
 * `dolt-fake.sh`) passed validation and could be killed by
 * `stopManagedProcess --force`, or laundered into a "trusted" status.
 *
 * The new check requires an exact basename match between the metadata's
 * recorded executable and the basename reported by `ps -o comm=`. `comm`
 * is just the executable basename (no args, no path), so equality is
 * meaningful and not subject to spoofing via padded args.
 *
 * Trade-off: a process invoked by absolute path under one binary name
 * (e.g. `/usr/local/bin/dolt`) and the metadata's basename `dolt` still
 * match, so legitimate setups continue to pass. A process running under
 * a renamed binary (`exec -a fake-dolt /usr/bin/dolt`) won't match —
 * intentional; we trust `ps` over user-supplied metadata.
 */
async function validateProcessCommand(metadata: ManagedProcessMetadata): Promise<Result<boolean, StorageError>> {
  const expectedExecutable = path.basename(metadata.command[0] ?? "");
  if (!expectedExecutable) return ok(false);
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(metadata.pid), "-o", "comm="], {
      timeout: 1000,
      maxBuffer: 64 * 1024,
      encoding: "utf-8",
    });
    const actualBasename = path.basename(stdout.trim());
    if (!actualBasename) return ok(false);
    return ok(actualBasename === expectedExecutable);
  } catch (error) {
    return err(new StorageError("Failed to inspect process command", { pid: metadata.pid, cause: String(error) }));
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
