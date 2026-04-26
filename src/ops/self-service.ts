import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { VERSION } from "../core/constants.js";
import { StorageError, ValidationError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import { backupWorkspace, inspectWorkspace, migrateWorkspace, type WorkspaceBackup, type WorkspaceStatus } from "../workspace/service.js";
import { inspectManagedProcess, stopManagedProcess, type ManagedProcessStatus } from "./process-registry.js";

const execFileAsync = promisify(execFile);

export interface GitInstallStatus {
  readonly path: string;
  readonly isGitCheckout: boolean;
  readonly branch?: string;
  readonly head?: string;
  readonly upstreamHead?: string;
  readonly dirty?: boolean;
  readonly error?: string;
}

export interface SelfStatus {
  readonly version: string;
  readonly install: GitInstallStatus;
  readonly workspace: WorkspaceStatus;
  readonly processes: {
    readonly dolt: ManagedProcessStatus;
  };
}

export interface SelfUpdatePlan {
  readonly mode: "dry-run";
  readonly installPath: string;
  readonly repoPath: string;
  readonly steps: string[];
  readonly blockers: string[];
}

export interface SelfUpdateStepResult {
  readonly name: string;
  readonly status: "completed" | "skipped";
  readonly output?: string;
}

export interface SelfUpdateExecution {
  readonly mode: "execute";
  readonly installPath: string;
  readonly repoPath: string;
  readonly backup: WorkspaceBackup;
  readonly steps: SelfUpdateStepResult[];
  readonly doltRestarted: boolean;
}

export interface SelfRestartResult {
  readonly service: "dolt";
  readonly stopped: ManagedProcessStatus;
  readonly started: boolean;
  readonly output: string;
}

export async function inspectSelf(options: {
  readonly installPath?: string;
  readonly repoPath?: string;
} = {}): Promise<Result<SelfStatus, StorageError>> {
  const installPath = path.resolve(options.installPath ?? process.cwd());
  const repoPath = path.resolve(options.repoPath ?? process.cwd());
  const [install, workspace, dolt] = await Promise.all([
    inspectGitInstall(installPath),
    inspectWorkspace(repoPath),
    inspectManagedProcess(installPath, "dolt"),
  ]);

  if (!install.ok) return install;
  if (!workspace.ok) return workspace;
  if (!dolt.ok) return dolt;

  return ok({
    version: VERSION,
    install: install.value,
    workspace: workspace.value,
    processes: { dolt: dolt.value },
  });
}

export async function planSelfUpdate(options: {
  readonly installPath?: string;
  readonly repoPath?: string;
} = {}): Promise<Result<SelfUpdatePlan, StorageError>> {
  const status = await inspectSelf(options);
  if (!status.ok) return status;

  const blockers: string[] = [];
  if (!status.value.install.isGitCheckout) blockers.push("installation is not a git checkout");
  if (status.value.install.dirty) blockers.push("installation working tree is dirty");
  if (status.value.workspace.schema.compatible === false) blockers.push("workspace schema is newer than this Monsthera version");
  if (status.value.processes.dolt.running && !status.value.processes.dolt.trusted) {
    blockers.push("Dolt process is running but metadata is not trusted");
  }

  return ok({
    mode: "dry-run",
    installPath: status.value.install.path,
    repoPath: status.value.workspace.repoPath,
    blockers,
    steps: [
      "workspace backup",
      "stop managed Dolt if running",
      "git pull --ff-only",
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "workspace migrate",
      "reindex",
      "restart Dolt if it was running before update",
      "restart MCP client so stdio server reloads",
    ],
  });
}

export async function restartDolt(options: {
  readonly installPath?: string;
  readonly force?: boolean;
} = {}): Promise<Result<SelfRestartResult, StorageError | ValidationError>> {
  const installPath = path.resolve(options.installPath ?? process.cwd());
  const stopped = await stopManagedProcess(installPath, "dolt", { force: options.force });
  if (!stopped.ok) return stopped;

  const script = path.join(installPath, "scripts", "dolt", "start-local.sh");
  const started = await startDoltDaemon(installPath, script);
  if (!started.ok) return started;
  return ok({
    service: "dolt",
    stopped: stopped.value,
    started: true,
    output: started.value,
  });
}

export async function executeSelfUpdate(options: {
  readonly installPath?: string;
  readonly repoPath?: string;
} = {}): Promise<Result<SelfUpdateExecution, StorageError | ValidationError>> {
  const plan = await planSelfUpdate(options);
  if (!plan.ok) return plan;
  if (plan.value.blockers.length > 0) {
    return err(new ValidationError("self update has blockers", { blockers: plan.value.blockers }));
  }

  const initial = await inspectSelf(options);
  if (!initial.ok) return initial;

  const installPath = plan.value.installPath;
  const repoPath = plan.value.repoPath;
  const steps: SelfUpdateStepResult[] = [];

  const backup = await backupWorkspace(repoPath);
  if (!backup.ok) return backup;
  steps.push({ name: "workspace backup", status: "completed", output: backup.value.path });

  const shouldRestartDolt = initial.value.processes.dolt.running;
  if (shouldRestartDolt) {
    const stopped = await stopManagedProcess(installPath, "dolt");
    if (!stopped.ok) return stopped;
    steps.push({ name: "stop managed Dolt", status: "completed", output: stopped.value.pid ? `pid ${stopped.value.pid}` : "not running" });
  } else {
    steps.push({ name: "stop managed Dolt", status: "skipped", output: "not running" });
  }

  const commands: Array<{ readonly name: string; readonly command: string; readonly args: string[]; readonly cwd: string; readonly timeoutMs: number }> = [
    { name: "git pull --ff-only", command: "git", args: ["pull", "--ff-only"], cwd: installPath, timeoutMs: 60000 },
    { name: "pnpm install --frozen-lockfile", command: "pnpm", args: ["install", "--frozen-lockfile"], cwd: installPath, timeoutMs: 120000 },
    { name: "pnpm build", command: "pnpm", args: ["build"], cwd: installPath, timeoutMs: 120000 },
  ];

  for (const command of commands) {
    const result = await runCommand(command.command, command.args, command.cwd, command.timeoutMs);
    if (!result.ok) return result;
    steps.push({ name: command.name, status: "completed", output: result.value });
  }

  const migrated = await migrateWorkspace(repoPath);
  if (!migrated.ok) return migrated;
  steps.push({
    name: "workspace migrate",
    status: "completed",
    output: migrated.value.created ? "created manifest" : "updated manifest",
  });

  const reindex = await runCommand(process.execPath, [path.join(installPath, "dist", "bin.js"), "reindex", "--repo", repoPath], installPath, 120000);
  if (!reindex.ok) return reindex;
  steps.push({ name: "reindex", status: "completed", output: reindex.value });

  let doltRestarted = false;
  if (shouldRestartDolt) {
    const started = await startDoltDaemon(installPath, path.join(installPath, "scripts", "dolt", "start-local.sh"));
    if (!started.ok) return started;
    steps.push({ name: "restart Dolt", status: "completed", output: started.value });
    doltRestarted = true;
  } else {
    steps.push({ name: "restart Dolt", status: "skipped", output: "was not running before update" });
  }

  steps.push({ name: "restart MCP client", status: "skipped", output: "manual restart required for stdio clients" });

  return ok({
    mode: "execute",
    installPath,
    repoPath,
    backup: backup.value,
    steps,
    doltRestarted,
  });
}

async function startDoltDaemon(installPath: string, script: string): Promise<Result<string, StorageError>> {
  try {
    const { stdout, stderr } = await execFileAsync(script, ["--daemon"], {
      cwd: installPath,
      env: { ...process.env, MONSTHERA_VERSION: VERSION },
      timeout: 10000,
      maxBuffer: 256 * 1024,
    });
    return ok([stdout.trim(), stderr.trim()].filter(Boolean).join("\n"));
  } catch (error) {
    return err(new StorageError("Failed to start Dolt daemon", { cause: String(error) }));
  }
}

export async function prepareSelfUpdate(options: {
  readonly installPath?: string;
  readonly repoPath?: string;
} = {}): Promise<Result<{ backup: WorkspaceBackup; plan: SelfUpdatePlan }, StorageError | ValidationError>> {
  const repoPath = path.resolve(options.repoPath ?? process.cwd());
  const backup = await backupWorkspace(repoPath);
  if (!backup.ok) return backup;
  const migrated = await migrateWorkspace(repoPath);
  if (!migrated.ok) return migrated;
  const plan = await planSelfUpdate(options);
  if (!plan.ok) return plan;
  return ok({ backup: backup.value, plan: plan.value });
}

async function inspectGitInstall(installPath: string): Promise<Result<GitInstallStatus, StorageError>> {
  const resolved = path.resolve(installPath);
  const root = await git(resolved, ["rev-parse", "--show-toplevel"]);
  if (!root.ok) {
    return ok({ path: resolved, isGitCheckout: false, error: root.error.message });
  }

  const gitRoot = root.value.trim();
  const [branch, head, upstreamHead, dirty] = await Promise.all([
    git(gitRoot, ["branch", "--show-current"]),
    git(gitRoot, ["rev-parse", "HEAD"]),
    git(gitRoot, ["rev-parse", "--verify", "origin/main"]),
    git(gitRoot, ["status", "--porcelain"]),
  ]);

  return ok({
    path: gitRoot,
    isGitCheckout: true,
    branch: branch.ok ? branch.value.trim() : undefined,
    head: head.ok ? head.value.trim() : undefined,
    upstreamHead: upstreamHead.ok ? upstreamHead.value.trim() : undefined,
    dirty: dirty.ok ? dirty.value.trim().length > 0 : undefined,
  });
}

async function git(cwd: string, args: string[]): Promise<Result<string, StorageError>> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 5000,
      maxBuffer: 128 * 1024,
    });
    return ok(stdout);
  } catch (error) {
    return err(new StorageError(`git ${args.join(" ")} failed`, { cause: String(error) }));
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
): Promise<Result<string, StorageError>> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
    return ok([stdout.trim(), stderr.trim()].filter(Boolean).join("\n"));
  } catch (error) {
    return err(new StorageError(`${command} ${args.join(" ")} failed`, { cause: String(error) }));
  }
}
