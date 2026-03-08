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
