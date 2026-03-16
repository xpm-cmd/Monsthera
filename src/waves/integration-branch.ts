import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MergeResult } from "../git/worktree.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

async function git(args: string[], opts: { cwd: string; timeout?: number }): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: opts.cwd,
    maxBuffer: MAX_BUFFER,
    timeout: opts.timeout ?? 30_000,
  });
  return stdout.trimEnd();
}

/**
 * Creates an integration branch `agora/convoy/{groupId}` from HEAD.
 * Does not check out the branch.
 */
export async function createIntegrationBranch(
  repoRoot: string,
  groupId: string,
): Promise<{ branchName: string }> {
  const branchName = `agora/convoy/${groupId}`;
  await git(["branch", branchName], { cwd: repoRoot });
  return { branchName };
}

/**
 * Creates a worktree at `.agora/worktrees/{sessionId}` branching from the integration branch.
 * Branch name: `agora/agent/{sessionId}`.
 */
export async function createConvoyWorktree(
  repoRoot: string,
  sessionId: string,
  integrationBranch: string,
): Promise<{ worktreePath: string; branchName: string }> {
  const branchName = `agora/agent/${sessionId}`;
  const worktreePath = `${repoRoot}/.agora/worktrees/${sessionId}`;
  await git(["worktree", "add", "-b", branchName, worktreePath, integrationBranch], { cwd: repoRoot });
  return { worktreePath, branchName };
}

/**
 * Merges agentBranch into integrationBranch using --no-ff.
 * Checks out the integration branch, merges, then returns to the original branch.
 */
export async function mergeTicketToIntegration(
  repoRoot: string,
  integrationBranch: string,
  agentBranch: string,
  commitMessage: string,
): Promise<MergeResult> {
  const originalBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot });
  await git(["checkout", integrationBranch], { cwd: repoRoot });
  try {
    await git(["merge", "--no-ff", "-m", commitMessage, agentBranch], { cwd: repoRoot });
    const sha = await git(["rev-parse", "HEAD"], { cwd: repoRoot });
    await git(["checkout", originalBranch], { cwd: repoRoot });
    return { merged: true, commitSha: sha, conflicts: [] };
  } catch {
    try {
      const conflictOutput = await git(["diff", "--name-only", "--diff-filter=U"], { cwd: repoRoot });
      const conflicts = conflictOutput.split("\n").filter(Boolean);
      await git(["merge", "--abort"], { cwd: repoRoot });
      await git(["checkout", originalBranch], { cwd: repoRoot });
      return { merged: false, commitSha: null, conflicts };
    } catch {
      try { await git(["merge", "--abort"], { cwd: repoRoot }); } catch { /* already clean */ }
      try { await git(["checkout", originalBranch], { cwd: repoRoot }); } catch { /* best effort */ }
      return { merged: false, commitSha: null, conflicts: ["unknown conflict"] };
    }
  }
}

/**
 * Rebases the current branch in worktreePath onto targetBranch.
 * On conflict: aborts rebase and returns conflict list.
 */
export async function rebaseOnBranch(
  worktreePath: string,
  targetBranch: string,
): Promise<{ rebased: boolean; conflicts: string[] }> {
  try {
    await git(["rebase", targetBranch], { cwd: worktreePath });
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
 * Merges the integration branch into main/HEAD using --no-ff.
 * Must be called from the main repo root while on the main branch.
 */
export async function mergeIntegrationToMain(
  repoRoot: string,
  integrationBranch: string,
  commitMessage: string,
): Promise<MergeResult> {
  try {
    await git(["merge", "--no-ff", "-m", commitMessage, integrationBranch], { cwd: repoRoot });
    const sha = await git(["rev-parse", "HEAD"], { cwd: repoRoot });
    return { merged: true, commitSha: sha, conflicts: [] };
  } catch {
    try {
      const conflictOutput = await git(["diff", "--name-only", "--diff-filter=U"], { cwd: repoRoot });
      const conflicts = conflictOutput.split("\n").filter(Boolean);
      await git(["merge", "--abort"], { cwd: repoRoot });
      return { merged: false, commitSha: null, conflicts };
    } catch {
      try { await git(["merge", "--abort"], { cwd: repoRoot }); } catch { /* already clean */ }
      return { merged: false, commitSha: null, conflicts: ["unknown conflict"] };
    }
  }
}

/**
 * Deletes the integration branch. Safe to call if branch doesn't exist.
 */
export async function cleanupIntegrationBranch(
  repoRoot: string,
  branchName: string,
): Promise<void> {
  try {
    await git(["branch", "-d", branchName], { cwd: repoRoot });
  } catch { /* branch may not exist or not fully merged — ignore */ }
}
