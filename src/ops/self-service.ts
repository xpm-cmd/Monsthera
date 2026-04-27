import * as path from "node:path";
import { VERSION } from "../core/constants.js";
import { StorageError, ValidationError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import {
  backupWorkspace,
  inspectWorkspace,
  migrateWorkspace,
  restoreWorkspace,
  type WorkspaceBackup,
  type WorkspaceRestore,
  type WorkspaceStatus,
} from "../workspace/service.js";
import {
  combineOutput,
  realCommandRunner,
  type CommandRunner,
} from "./command-runner.js";
import {
  inspectManagedProcess,
  stopManagedProcess,
  type ManagedProcessStatus,
} from "./process-registry.js";

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
  readonly status: "completed" | "skipped" | "failed";
  readonly output?: string;
}

export interface SelfUpdateRollback {
  readonly performed: boolean;
  readonly backupPath: string;
  readonly restored: readonly string[];
  readonly skipped: readonly string[];
  readonly doltRestarted: boolean;
  readonly errors: readonly string[];
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

export interface SelfServiceOptions {
  readonly installPath?: string;
  readonly repoPath?: string;
  readonly runner?: CommandRunner;
}

export async function inspectSelf(
  options: SelfServiceOptions = {},
): Promise<Result<SelfStatus, StorageError>> {
  const installPath = path.resolve(options.installPath ?? process.cwd());
  const repoPath = path.resolve(options.repoPath ?? process.cwd());
  const runner = options.runner ?? realCommandRunner;
  const [install, workspace, dolt] = await Promise.all([
    inspectGitInstall(installPath, runner),
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

export async function planSelfUpdate(
  options: SelfServiceOptions = {},
): Promise<Result<SelfUpdatePlan, StorageError>> {
  const status = await inspectSelf(options);
  if (!status.ok) return status;

  const blockers: string[] = [];
  if (!status.value.install.isGitCheckout) blockers.push("installation is not a git checkout");
  if (status.value.install.dirty) blockers.push("installation working tree is dirty");
  if (status.value.workspace.schema.compatible === false)
    blockers.push("workspace schema is newer than this Monsthera version");
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

export async function restartDolt(
  options: SelfServiceOptions & { readonly force?: boolean } = {},
): Promise<Result<SelfRestartResult, StorageError | ValidationError>> {
  const installPath = path.resolve(options.installPath ?? process.cwd());
  const runner = options.runner ?? realCommandRunner;
  const stopped = await stopManagedProcess(installPath, "dolt", { force: options.force });
  if (!stopped.ok) return stopped;

  const started = await startDoltDaemon(installPath, runner);
  if (!started.ok) return started;
  return ok({
    service: "dolt",
    stopped: stopped.value,
    started: true,
    output: started.value,
  });
}

export async function prepareSelfUpdate(
  options: SelfServiceOptions = {},
): Promise<
  Result<{ backup: WorkspaceBackup; plan: SelfUpdatePlan }, StorageError | ValidationError>
> {
  const repoPath = path.resolve(options.repoPath ?? process.cwd());
  const backup = await backupWorkspace(repoPath);
  if (!backup.ok) return backup;
  const migrated = await migrateWorkspace(repoPath);
  if (!migrated.ok) return migrated;
  const plan = await planSelfUpdate(options);
  if (!plan.ok) return plan;
  return ok({ backup: backup.value, plan: plan.value });
}

interface UpdateStep {
  readonly name: string;
  readonly run: () => Promise<Result<string, StorageError | ValidationError>>;
}

interface UpdateContext {
  readonly installPath: string;
  readonly repoPath: string;
  readonly runner: CommandRunner;
  readonly backup: WorkspaceBackup;
  readonly doltWasRunning: boolean;
}

export async function executeSelfUpdate(
  options: SelfServiceOptions = {},
): Promise<Result<SelfUpdateExecution, StorageError | ValidationError>> {
  const runner = options.runner ?? realCommandRunner;
  const plan = await planSelfUpdate({ ...options, runner });
  if (!plan.ok) return plan;
  if (plan.value.blockers.length > 0) {
    return err(
      new ValidationError("self update has blockers", {
        blockers: plan.value.blockers,
      }),
    );
  }

  const initial = await inspectSelf({ ...options, runner });
  if (!initial.ok) return initial;

  const installPath = plan.value.installPath;
  const repoPath = plan.value.repoPath;

  // Stop Dolt FIRST (before backup) so the backup captures a quiesced
  // .monsthera/dolt/ directory. Backing up while the daemon holds
  // memory-mapped pages dirty produces an inconsistent snapshot that the
  // rollback path then cannot trust.
  const completed: SelfUpdateStepResult[] = [];
  const doltWasRunning = initial.value.processes.dolt.running;
  if (doltWasRunning) {
    const stopped = await stopManagedProcess(installPath, "dolt");
    if (!stopped.ok) {
      // No backup yet, nothing to roll back. Just report the stop failure.
      return err(stopped.error);
    }
    completed.push({
      name: "stop managed Dolt",
      status: "completed",
      output: stopped.value.pid ? `pid ${stopped.value.pid}` : "not running",
    });
  } else {
    completed.push({ name: "stop managed Dolt", status: "skipped", output: "not running" });
  }

  const backup = await backupWorkspace(repoPath);
  if (!backup.ok) {
    // Backup failed AFTER stopping Dolt — try to restart Dolt so the user
    // is left in a clean state, then surface the backup error.
    if (doltWasRunning) {
      const restarted = await startDoltDaemon(installPath, runner);
      if (!restarted.ok) {
        return err(
          new StorageError(
            `workspace backup failed and Dolt restart failed: ${backup.error.message}; restart error: ${restarted.error.message}`,
            { backupError: backup.error.message, restartError: restarted.error.message },
          ),
        );
      }
    }
    return backup;
  }
  completed.push({ name: "workspace backup", status: "completed", output: backup.value.path });

  const context: UpdateContext = {
    installPath,
    repoPath,
    runner,
    backup: backup.value,
    doltWasRunning,
  };

  const steps: UpdateStep[] = [
    {
      name: "git pull --ff-only",
      run: async () => {
        const result = await runner({
          command: "git",
          args: ["pull", "--ff-only"],
          cwd: installPath,
          timeoutMs: 60000,
        });
        return mapCommand(result);
      },
    },
    {
      name: "pnpm install --frozen-lockfile",
      run: async () => {
        const result = await runner({
          command: "pnpm",
          args: ["install", "--frozen-lockfile"],
          cwd: installPath,
          timeoutMs: 120000,
        });
        return mapCommand(result);
      },
    },
    {
      name: "pnpm build",
      run: async () => {
        const result = await runner({
          command: "pnpm",
          args: ["build"],
          cwd: installPath,
          timeoutMs: 120000,
        });
        return mapCommand(result);
      },
    },
    {
      name: "workspace migrate",
      run: async () => {
        const migrated = await migrateWorkspace(repoPath);
        if (!migrated.ok) return migrated;
        return ok(migrated.value.created ? "created manifest" : "updated manifest");
      },
    },
    {
      name: "reindex",
      run: async () => {
        const result = await runner({
          command: process.execPath,
          args: [path.join(installPath, "dist", "bin.js"), "reindex", "--repo", repoPath],
          cwd: installPath,
          timeoutMs: 120000,
        });
        return mapCommand(result);
      },
    },
  ];

  for (const step of steps) {
    const result = await step.run();
    if (!result.ok) {
      return failExecution(result.error, step.name, completed, context);
    }
    completed.push({ name: step.name, status: "completed", output: result.value });
  }

  let doltRestarted = false;
  if (doltWasRunning) {
    const started = await startDoltDaemon(installPath, runner);
    if (!started.ok) {
      return failExecution(started.error, "restart Dolt", completed, context);
    }
    completed.push({ name: "restart Dolt", status: "completed", output: started.value });
    doltRestarted = true;
  } else {
    completed.push({
      name: "restart Dolt",
      status: "skipped",
      output: "was not running before update",
    });
  }

  completed.push({
    name: "restart MCP client",
    status: "skipped",
    output: "manual restart required for stdio clients",
  });

  return ok({
    mode: "execute",
    installPath,
    repoPath,
    backup: backup.value,
    steps: completed,
    doltRestarted,
  });
}

async function failExecution(
  cause: StorageError | ValidationError,
  failedStep: string,
  completed: SelfUpdateStepResult[],
  context: UpdateContext,
): Promise<Result<SelfUpdateExecution, StorageError | ValidationError>> {
  const stepLog = [...completed, { name: failedStep, status: "failed" as const, output: cause.message }];
  const rollback = await performRollback(context);
  return err(
    new StorageError(`self update failed at "${failedStep}": ${cause.message}`, {
      failedStep,
      cause: cause.message,
      causeCode: cause.code,
      causeDetails: cause.details,
      rollback,
      steps: stepLog,
      backupPath: context.backup.path,
    }),
  );
}

async function performRollback(context: UpdateContext): Promise<SelfUpdateRollback> {
  const errors: string[] = [];
  let restored: WorkspaceRestore = { backupId: context.backup.id, restored: [], skipped: [] };

  const restore = await restoreWorkspace(context.repoPath, context.backup.path, { force: true });
  if (!restore.ok) {
    errors.push(`workspace restore failed: ${restore.error.message}`);
  } else {
    restored = restore.value;
  }

  let doltRestarted = false;
  // Only attempt to restart Dolt if the workspace actually came back to a known
  // good state. Restarting Dolt on top of a half-restored workspace can leave
  // the user with a running daemon over corrupt data.
  if (context.doltWasRunning && restore.ok) {
    const started = await startDoltDaemon(context.installPath, context.runner);
    if (!started.ok) {
      errors.push(`dolt restart failed: ${started.error.message}`);
    } else {
      doltRestarted = true;
    }
  } else if (context.doltWasRunning && !restore.ok) {
    errors.push("dolt was not restarted because workspace restore failed; resolve manually");
  }

  return {
    performed: restore.ok,
    backupPath: context.backup.path,
    restored: restored.restored,
    skipped: restored.skipped,
    doltRestarted,
    errors,
  };
}

function mapCommand(
  result: Result<{ readonly stdout: string; readonly stderr: string }, StorageError>,
): Result<string, StorageError> {
  if (!result.ok) return result;
  return ok(combineOutput(result.value));
}

async function startDoltDaemon(
  installPath: string,
  runner: CommandRunner,
): Promise<Result<string, StorageError>> {
  const script = path.join(installPath, "scripts", "dolt", "start-local.sh");
  const result = await runner({
    command: script,
    args: ["--daemon"],
    cwd: installPath,
    timeoutMs: 10000,
    env: { ...process.env, MONSTHERA_VERSION: VERSION },
    maxBufferBytes: 256 * 1024,
  });
  if (!result.ok) {
    return err(new StorageError("Failed to start Dolt daemon", { cause: result.error.message }));
  }
  return ok(combineOutput(result.value));
}

async function inspectGitInstall(
  installPath: string,
  runner: CommandRunner,
): Promise<Result<GitInstallStatus, StorageError>> {
  const resolved = path.resolve(installPath);
  const root = await runGit(resolved, ["rev-parse", "--show-toplevel"], runner);
  if (!root.ok) {
    return ok({ path: resolved, isGitCheckout: false, error: root.error.message });
  }

  const gitRoot = root.value.trim();
  const [branch, head, upstreamHead, dirty] = await Promise.all([
    runGit(gitRoot, ["branch", "--show-current"], runner),
    runGit(gitRoot, ["rev-parse", "HEAD"], runner),
    runGit(gitRoot, ["rev-parse", "--verify", "origin/main"], runner),
    runGit(gitRoot, ["status", "--porcelain"], runner),
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

async function runGit(
  cwd: string,
  args: string[],
  runner: CommandRunner,
): Promise<Result<string, StorageError>> {
  const result = await runner({
    command: "git",
    args,
    cwd,
    timeoutMs: 5000,
    maxBufferBytes: 128 * 1024,
  });
  if (!result.ok) return result;
  return ok(result.value.stdout);
}
