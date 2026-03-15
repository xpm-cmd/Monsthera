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
 * Creates a worktree at .agora/worktrees/<sessionId> on branch agora/agent/<sessionId>.
 * The branch starts from current HEAD of main.
 */
export async function createAgentWorktree(
  mainRepoRoot: string,
  sessionId: string,
): Promise<{ worktreePath: string; branchName: string }> {
  const branchName = `agora/agent/${sessionId}`;
  const worktreePath = `${mainRepoRoot}/.agora/worktrees/${sessionId}`;
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
  const worktreePath = `${mainRepoRoot}/.agora/worktrees/${sessionId}`;
  const branchName = `agora/agent/${sessionId}`;
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
    } catch {
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
    } catch {
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
  // Filter to only agora agent worktrees
  return entries.filter((e) => e.branch?.startsWith("agora/agent/"));
}

/**
 * Run a test command in the agent's worktree.
 * Returns pass/fail with output summary.
 */
export async function runTestsInWorktree(
  worktreePath: string,
  testCommand: string,
  timeoutMs: number = 120_000,
): Promise<{ passed: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", testCommand], {
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
