import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

export interface GitExecOptions {
  cwd: string;
  timeout?: number;
}

async function git(args: string[], opts: GitExecOptions): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: opts.cwd,
    maxBuffer: MAX_BUFFER,
    timeout: opts.timeout ?? 30_000,
  });
  return stdout.trimEnd();
}

export async function getHead(opts: GitExecOptions): Promise<string> {
  return git(["rev-parse", "HEAD"], opts);
}

export async function getShortSha(sha: string, opts: GitExecOptions): Promise<string> {
  return git(["rev-parse", "--short", sha], opts);
}

export async function getCommitMessage(commit: string, opts: GitExecOptions): Promise<string> {
  return git(["show", "-s", "--format=%B", commit], opts);
}

export interface ChangedFile {
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X";
  path: string;
  oldPath?: string; // for renames
}

export async function getChangedFiles(
  fromCommit: string,
  toCommit: string,
  opts: GitExecOptions,
): Promise<ChangedFile[]> {
  const output = await git(["diff", "--name-status", "--no-renames", fromCommit, toCommit], opts);
  if (!output) return [];

  return output.split("\n").map((line) => {
    const [status, ...pathParts] = line.split("\t");
    return { status: status as ChangedFile["status"], path: pathParts.join("\t") };
  });
}

/**
 * Get per-file diff stats (lines added/removed) between two commits.
 * Uses `git diff --numstat` which is fast and produces compact output.
 */
export async function getDiffStats(
  fromCommit: string,
  toCommit: string,
  opts: GitExecOptions,
): Promise<Map<string, { added: number; removed: number }>> {
  const output = await git(["diff", "--numstat", fromCommit, toCommit], opts);
  const stats = new Map<string, { added: number; removed: number }>();
  if (!output) return stats;

  for (const line of output.split("\n")) {
    const [addedStr, removedStr, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    // Binary files show "-" for added/removed
    const added = addedStr === "-" ? 0 : parseInt(addedStr!, 10);
    const removed = removedStr === "-" ? 0 : parseInt(removedStr!, 10);
    stats.set(path, { added: isNaN(added) ? 0 : added, removed: isNaN(removed) ? 0 : removed });
  }
  return stats;
}

/**
 * Get the full unified diff between two commits, split into per-file entries.
 * Each entry is truncated to maxLinesPerFile to keep the response manageable.
 */
export async function getPerFileDiffs(
  fromCommit: string,
  toCommit: string,
  maxLinesPerFile: number,
  opts: GitExecOptions,
): Promise<Map<string, string>> {
  const diffs = new Map<string, string>();
  try {
    const output = await git(["diff", "-U3", fromCommit, toCommit], opts);
    if (!output) return diffs;

    // Split by "diff --git" boundary — each chunk is one file's diff
    const chunks = output.split(/^(?=diff --git )/m);
    for (const chunk of chunks) {
      if (!chunk.trim()) continue;
      // Extract path from "diff --git a/<path> b/<path>"
      const headerMatch = chunk.match(/^diff --git a\/(.+?) b\/(.+)/);
      if (!headerMatch) continue;
      const filePath = headerMatch[2]!;

      const lines = chunk.split("\n");
      if (lines.length <= maxLinesPerFile) {
        diffs.set(filePath, chunk);
      } else {
        const truncated = lines.slice(0, maxLinesPerFile).join("\n");
        diffs.set(filePath, `${truncated}\n... (${lines.length - maxLinesPerFile} more lines)`);
      }
    }
  } catch {
    // Non-fatal: diffs are supplementary
  }
  return diffs;
}

export async function getChangedFilesSinceCommit(
  sinceCommit: string,
  opts: GitExecOptions,
): Promise<ChangedFile[]> {
  const head = await getHead(opts);
  if (head === sinceCommit) return [];
  return getChangedFiles(sinceCommit, head, opts);
}

export async function getFileContent(path: string, commit: string, opts: GitExecOptions): Promise<string | null> {
  try {
    return await git(["show", `${commit}:${path}`], opts);
  } catch {
    return null; // file doesn't exist at this commit
  }
}

export async function getRecentCommits(
  count: number,
  opts: GitExecOptions,
): Promise<Array<{ sha: string; message: string; timestamp: string }>> {
  const output = await git(["log", `--max-count=${count}`, "--format=%H%x00%s%x00%aI"], opts);
  if (!output) return [];

  return output.split("\n").map((line) => {
    const [sha, message, timestamp] = line.split("\0");
    return { sha: sha!, message: message!, timestamp: timestamp! };
  });
}

export async function getAllTrackedFiles(commit: string, opts: GitExecOptions): Promise<string[]> {
  const output = await git(["ls-tree", "-r", "--name-only", commit], opts);
  if (!output) return [];
  return output.split("\n");
}

/**
 * Validate that a string refers to a valid git commit.
 * Returns true if the object exists and is a commit, false otherwise.
 */
export async function isValidCommit(sha: string, opts: GitExecOptions): Promise<boolean> {
  try {
    const type = await git(["cat-file", "-t", sha], opts);
    return type === "commit";
  } catch {
    return false;
  }
}

export async function isGitRepo(opts: GitExecOptions): Promise<boolean> {
  try {
    await git(["rev-parse", "--git-dir"], opts);
    return true;
  } catch {
    return false;
  }
}

export async function getRepoRoot(opts: GitExecOptions): Promise<string> {
  return git(["rev-parse", "--show-toplevel"], opts);
}

/**
 * Returns the main repository root, even when called from a git worktree.
 * Uses --git-common-dir which always points to the main repo's .git directory.
 * Safe for non-worktree usage — returns the same root as getRepoRoot().
 */
export async function getMainRepoRoot(opts: GitExecOptions): Promise<string> {
  const gitCommonDir = await git(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    opts,
  );
  return dirname(gitCommonDir);
}
