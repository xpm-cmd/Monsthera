import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitExecOptions } from "./operations.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

async function git(args: string[], opts: GitExecOptions): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: opts.cwd,
    maxBuffer: MAX_BUFFER,
    timeout: opts.timeout ?? 30_000,
  });
  return stdout.trimEnd();
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
}

export interface MergeResult {
  merged: boolean;
  commitSha: string | null;
  conflicts: string[];
}

/**
 * Creates a worktree at .monsthera/worktrees/<sessionId> on branch monsthera/agent/<sessionId>.
 * The branch starts from current HEAD of main.
 */
export async function createAgentWorktree(
  mainRepoRoot: string,
  sessionId: string,
): Promise<{ worktreePath: string; branchName: string }> {
  const branchName = `monsthera/agent/${sessionId}`;
  const worktreePath = `${mainRepoRoot}/.monsthera/worktrees/${sessionId}`;
  await git(["worktree", "add", "-b", branchName, worktreePath], { cwd: mainRepoRoot });
  return { worktreePath, branchName };
}

/**
 * Removes the worktree and deletes the branch.
 * Safe to call if worktree doesn't exist (no-op).
 */
export async function removeAgentWorktree(
  mainRepoRoot: string,
  sessionId: string,
): Promise<void> {
  const worktreePath = `${mainRepoRoot}/.monsthera/worktrees/${sessionId}`;
  const branchName = `monsthera/agent/${sessionId}`;
  try {
    await git(["worktree", "remove", "--force", worktreePath], { cwd: mainRepoRoot });
  } catch { /* worktree may not exist */ }
  try {
    await git(["branch", "-D", branchName], { cwd: mainRepoRoot });
  } catch { /* branch may not exist */ }
}

/**
 * Check if the agent's worktree branch has commits ahead of main.
 */
export async function hasUnmergedCommits(
  mainRepoRoot: string,
  branchName: string,
): Promise<boolean> {
  try {
    const count = await git(["rev-list", "--count", `HEAD..${branchName}`], { cwd: mainRepoRoot });
    return parseInt(count, 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Rebase the agent's branch onto the current HEAD of main.
 * Must be called from the worktree directory.
 * Returns success/failure with conflict details.
 */
export async function rebaseOnMain(
  worktreePath: string,
): Promise<{ rebased: boolean; conflicts: string[] }> {
  try {
    await git(["rebase", "main"], { cwd: worktreePath });
    return { rebased: true, conflicts: [] };
  } catch {
    try {
      const conflictOutput = await git(["diff", "--name-only", "--diff-filter=U"], { cwd: worktreePath });
      const conflicts = conflictOutput.split("\n").filter(Boolean);
      await git(["rebase", "--abort"], { cwd: worktreePath });
      return { rebased: false, conflicts };
    } catch (innerErr) {
      console.warn(`[monsthera] rebaseOnMain: failed to extract conflicts:`, innerErr);
      try { await git(["rebase", "--abort"], { cwd: worktreePath }); } catch { /* already clean */ }
      return { rebased: false, conflicts: ["unknown conflict"] };
    }
  }
}

/**
 * Merge the agent's branch back to main with --no-ff.
 * Must be called from the main repo root (not the worktree).
 * Returns merge result with conflict list if any.
 */
export async function mergeAgentWork(
  mainRepoRoot: string,
  branchName: string,
  commitMessage: string,
): Promise<MergeResult> {
  try {
    await git(["merge", "--no-ff", "-m", commitMessage, branchName], { cwd: mainRepoRoot });
    const sha = await git(["rev-parse", "HEAD"], { cwd: mainRepoRoot });
    return { merged: true, commitSha: sha, conflicts: [] };
  } catch {
    // Extract conflict file list
    try {
      const conflictOutput = await git(["diff", "--name-only", "--diff-filter=U"], { cwd: mainRepoRoot });
      const conflicts = conflictOutput.split("\n").filter(Boolean);
      // Abort the failed merge
      await git(["merge", "--abort"], { cwd: mainRepoRoot });
      return { merged: false, commitSha: null, conflicts };
    } catch (innerErr) {
      console.warn(`[monsthera] mergeAgentWork: failed to extract conflicts for ${branchName}:`, innerErr);
      return { merged: false, commitSha: null, conflicts: ["unknown conflict"] };
    }
  }
}

/**
 * List all active agent worktrees.
 */
export async function listAgentWorktrees(mainRepoRoot: string): Promise<WorktreeInfo[]> {
  const output = await git(["worktree", "list", "--porcelain"], { cwd: mainRepoRoot });
  const entries: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) current.path = line.slice(9);
    else if (line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (line.startsWith("branch ")) current.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "" && current.path) {
      entries.push(current as WorktreeInfo);
      current = {};
    }
  }
  if (current.path) entries.push(current as WorktreeInfo);
  // Filter to only monsthera agent worktrees
  return entries.filter((e) => e.branch?.startsWith("monsthera/agent/"));
}

/**
 * Remove worktrees whose sessionId is NOT in the active set.
 * Reuses listAgentWorktrees() to find candidates and removeAgentWorktree() to clean up.
 */
export async function cleanupOrphanedWorktrees(
  mainRepoRoot: string,
  activeSessions: Set<string>,
  opts?: { dryRun?: boolean },
): Promise<{ removed: string[]; errors: Array<{ sessionId: string; error: string }> }> {
  const worktrees = await listAgentWorktrees(mainRepoRoot);
  const removed: string[] = [];
  const errors: Array<{ sessionId: string; error: string }> = [];

  for (const wt of worktrees) {
    const sessionId = wt.branch.replace("monsthera/agent/", "");
    if (activeSessions.has(sessionId)) continue;

    if (opts?.dryRun) {
      removed.push(sessionId);
      continue;
    }

    try {
      await removeAgentWorktree(mainRepoRoot, sessionId);
      removed.push(sessionId);
    } catch (err) {
      errors.push({ sessionId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { removed, errors };
}

/** Allowed test commands — allowlist approach prevents command injection entirely. */
const ALLOWED_TEST_COMMANDS: ReadonlySet<string> = new Set([
  "npm test", "npm run test", "npx vitest run", "npx vitest",
  "npx jest", "yarn test", "pnpm test", "make test",
  "cargo test", "go test ./...", "pytest", "python -m pytest",
]);

/**
 * Run a test command in the agent's worktree.
 * Uses execFile with argument array (no shell) to prevent command injection.
 * Only allowlisted commands are permitted.
 */
export async function runTestsInWorktree(
  worktreePath: string,
  testCommand: string,
  timeoutMs: number = 120_000,
): Promise<{ passed: boolean; output: string }> {
  const trimmed = testCommand.trim();
  if (!ALLOWED_TEST_COMMANDS.has(trimmed)) {
    return {
      passed: false,
      output: `Rejected: testCommand is not in the allowlist. Allowed: ${[...ALLOWED_TEST_COMMANDS].join(", ")}`,
    };
  }

  const [cmd, ...args] = trimmed.split(/\s+/) as [string, ...string[]];

  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: worktreePath,
      maxBuffer: MAX_BUFFER,
      timeout: timeoutMs,
    });
    return { passed: true, output: (stdout + stderr).slice(-2000) };
  } catch (error: unknown) {
    const execError = error as { stdout?: string; stderr?: string };
    return {
      passed: false,
      output: ((execError.stdout ?? "") + (execError.stderr ?? "")).slice(-2000),
    };
  }
}
