import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mergeTicketToIntegration } from "./integration-branch.js";
import { runTestsInWorktree } from "../git/worktree.js";

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

export interface MergeQueueEntry {
  ticketId: string;
  agentBranch: string;      // monsthera/agent/{sessionId}
  commitMessage: string;
}

export interface MergeQueueResult {
  merged: string[];              // ticketIds successfully merged
  conflicted: string[];          // ticketIds that had merge conflicts
  testFailed: string[];          // ticketIds identified via bisect as test-breakers
  testsPassed: boolean | null;   // null if no testCommand
  bisectCulprit?: string;        // single ticketId that broke tests
}

/**
 * Processes a wave merge queue: sequentially merges entries into the
 * integration branch, optionally runs tests, and bisects on failure
 * to identify the culprit ticket.
 */
export async function processWaveMergeQueue(
  repoRoot: string,
  integrationBranch: string,
  entries: MergeQueueEntry[],
  opts?: {
    testCommand?: string;
    testTimeoutMs?: number;  // default 120_000
  },
): Promise<MergeQueueResult> {
  const result: MergeQueueResult = {
    merged: [],
    conflicted: [],
    testFailed: [],
    testsPassed: null,
  };

  if (entries.length === 0) {
    return result;
  }

  // Phase 1: Save pre-merge checkpoint
  const checkpointSha = await git(["rev-parse", integrationBranch], { cwd: repoRoot });

  // Phase 1: Sequential merge
  const mergedEntries: MergeQueueEntry[] = [];

  for (const entry of entries) {
    const mergeResult = await mergeTicketToIntegration(
      repoRoot,
      integrationBranch,
      entry.agentBranch,
      entry.commitMessage,
    );

    if (mergeResult.merged) {
      result.merged.push(entry.ticketId);
      mergedEntries.push(entry);
    } else {
      result.conflicted.push(entry.ticketId);
    }
  }

  // Phase 2: Test validation
  if (!opts?.testCommand || mergedEntries.length === 0) {
    return result;
  }

  const testTimeout = opts.testTimeoutMs ?? 120_000;
  const worktreePath = `${repoRoot}/.monsthera/worktrees/merge-queue-test`;

  try {
    // Create a temporary worktree for testing on the integration branch
    await git(["worktree", "add", worktreePath, integrationBranch], { cwd: repoRoot });

    const testResult = await runTestsInWorktree(worktreePath, opts.testCommand, testTimeout);

    if (testResult.passed) {
      result.testsPassed = true;
      return result;
    }

    // Tests failed
    result.testsPassed = false;

    if (mergedEntries.length === 1) {
      // Only one merged entry — it's the culprit
      const culprit = mergedEntries[0]!.ticketId;
      result.testFailed.push(culprit);
      result.bisectCulprit = culprit;
      return result;
    }

    // Phase 3: Bisect — need to clean up worktree first, then bisect
    await cleanupWorktree(repoRoot, worktreePath);

    const culpritId = await bisect(
      repoRoot,
      integrationBranch,
      checkpointSha,
      mergedEntries,
      opts.testCommand,
      testTimeout,
    );

    if (culpritId) {
      result.bisectCulprit = culpritId;
      result.testFailed.push(culpritId);
      result.merged = result.merged.filter((id) => id !== culpritId);

      // Reset and re-merge all except culprit
      await git(["branch", "-f", integrationBranch, checkpointSha], { cwd: repoRoot });
      for (const entry of mergedEntries) {
        if (entry.ticketId === culpritId) continue;
        await mergeTicketToIntegration(
          repoRoot,
          integrationBranch,
          entry.agentBranch,
          entry.commitMessage,
        );
      }
    }

    return result;
  } finally {
    await cleanupWorktree(repoRoot, worktreePath);
  }
}

/**
 * Binary search through merged entries to find the one that breaks tests.
 * Resets the integration branch, merges subsets, and tests each half.
 */
async function bisect(
  repoRoot: string,
  integrationBranch: string,
  checkpointSha: string,
  mergedEntries: MergeQueueEntry[],
  testCommand: string,
  testTimeout: number,
): Promise<string | undefined> {
  // Base case: single entry
  if (mergedEntries.length === 1) {
    return mergedEntries[0]!.ticketId;
  }

  // Base case: empty (shouldn't happen, but guard)
  if (mergedEntries.length === 0) {
    return undefined;
  }

  const mid = Math.ceil(mergedEntries.length / 2);
  const firstHalf = mergedEntries.slice(0, mid);

  // Reset to checkpoint and merge just the first half
  await git(["branch", "-f", integrationBranch, checkpointSha], { cwd: repoRoot });

  for (const entry of firstHalf) {
    await mergeTicketToIntegration(
      repoRoot,
      integrationBranch,
      entry.agentBranch,
      entry.commitMessage,
    );
  }

  // Test the first half
  const worktreePath = `${repoRoot}/.monsthera/worktrees/merge-queue-bisect`;
  try {
    await git(["worktree", "add", worktreePath, integrationBranch], { cwd: repoRoot });
    const testResult = await runTestsInWorktree(worktreePath, testCommand, testTimeout);
    await cleanupWorktree(repoRoot, worktreePath);

    if (testResult.passed) {
      // Culprit is in the second half
      const secondHalf = mergedEntries.slice(mid);
      return bisect(repoRoot, integrationBranch, checkpointSha, secondHalf, testCommand, testTimeout);
    } else {
      // Culprit is in the first half
      return bisect(repoRoot, integrationBranch, checkpointSha, firstHalf, testCommand, testTimeout);
    }
  } catch (err) {
    console.warn(`[monsthera] bisect: unexpected error during merge-queue bisection:`, err);
    await cleanupWorktree(repoRoot, worktreePath);
    return undefined;
  }
}

/**
 * Safely removes a worktree, ignoring errors if it doesn't exist.
 */
async function cleanupWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await git(["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
  } catch { /* worktree may not exist */ }
}
