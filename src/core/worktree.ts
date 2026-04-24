import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Result of inspecting a path's `.git` entry. `isWorktree` is true when
 * the entry is a regular file with a `gitdir:` pointer (the shape that
 * `git worktree add` creates); false for a real `.git/` directory or
 * when no `.git` is present at all. `mainRepoPath` is populated only on
 * worktrees and resolves to the directory whose `.git` is the canonical
 * git dir.
 */
export interface WorktreeStatus {
  readonly isWorktree: boolean;
  readonly mainRepoPath?: string;
  readonly worktreePath?: string;
}

/**
 * Inspect `repoPath/.git` and classify it as worktree, main repo, or
 * neither. The implementation only touches the filesystem so it is
 * safe to call before the runtime container is built.
 *
 * Heuristic mirrors git's own: `.git` is a regular file in a worktree
 * (with `gitdir: <path>` content) and a directory in a main repo.
 */
export async function detectWorktree(repoPath: string): Promise<WorktreeStatus> {
  const gitEntry = path.join(repoPath, ".git");
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(gitEntry);
  } catch {
    return { isWorktree: false };
  }

  if (stat.isDirectory()) {
    return { isWorktree: false, mainRepoPath: repoPath };
  }
  if (!stat.isFile()) {
    return { isWorktree: false };
  }

  let raw: string;
  try {
    raw = await fs.readFile(gitEntry, "utf8");
  } catch {
    return { isWorktree: false };
  }

  const match = /^gitdir:\s*(.+?)\s*$/m.exec(raw);
  if (!match || match[1] === undefined) return { isWorktree: false };
  const gitDir = path.isAbsolute(match[1]) ? match[1] : path.resolve(repoPath, match[1]);

  let commonDir = gitDir;
  try {
    const commondirRaw = await fs.readFile(path.join(gitDir, "commondir"), "utf8");
    const trimmed = commondirRaw.trim();
    commonDir = path.isAbsolute(trimmed) ? trimmed : path.resolve(gitDir, trimmed);
  } catch {
    // commondir is optional; fall back to gitDir when missing.
  }

  return {
    isWorktree: true,
    mainRepoPath: path.dirname(commonDir),
    worktreePath: repoPath,
  };
}
