import * as path from "node:path";
import { ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import { StorageError } from "../core/errors.js";
import type { CommandRunner } from "../ops/command-runner.js";

/**
 * Worktree-aware workspace resolution.
 *
 * When a user runs Monsthera from a git worktree (e.g.
 * `<repo>/.claude/worktrees/feature-x/`), the worktree's own knowledge
 * directory is initially empty — session records and handoff articles
 * committed on the main branch live in `<repo>/knowledge/`, not in the
 * worktree's copy. Without cross-worktree visibility, `session open`
 * cannot surface the prior session's TL;DR, and `knowledge get
 * handoff-...` cannot read the article that's sitting one directory up.
 *
 * `git rev-parse --git-common-dir` is the canonical way to find the
 * shared .git directory regardless of which worktree you're in. Its
 * parent is the main repository's working root. That root's
 * `knowledge/` directory is the natural fallback location for
 * cross-worktree reads.
 */

export interface WorkspaceLocation {
  /**
   * Absolute path to the workspace's "true" working root — equivalent
   * to `dirname($(git rev-parse --git-common-dir))`. In the main
   * worktree this equals `workspacePath`. In a feature worktree this
   * points at the parent repository.
   */
  readonly commonRoot: string;
  /** True when `workspacePath !== commonRoot`. */
  readonly isWorktree: boolean;
}

/**
 * Resolve the workspace's commonRoot for cross-worktree reads.
 *
 * Returns null when:
 *   - git is unavailable or the path is not a git repository (the
 *     workspace stands alone; no fallback applies).
 *   - The command output cannot be parsed.
 *
 * Returns the resolved location otherwise. Callers that only care
 * about the fallback path can ignore `null` results and proceed with
 * the worktree as-is — every read still works against the worktree's
 * primary directory.
 */
export async function resolveWorkspaceLocation(
  workspacePath: string,
  runner: CommandRunner,
  options: { timeoutMs?: number } = {},
): Promise<Result<WorkspaceLocation | null, StorageError>> {
  const absoluteWorkspace = path.resolve(workspacePath);
  const result = await runner({
    command: "git",
    args: ["rev-parse", "--git-common-dir"],
    cwd: absoluteWorkspace,
    timeoutMs: options.timeoutMs ?? 5_000,
  });

  if (!result.ok) {
    // Not a git repo, git binary missing, or path doesn't exist — all
    // legitimate reasons to skip the fallback rather than fail.
    return ok(null);
  }

  const raw = result.value.stdout.trim();
  if (raw.length === 0) return ok(null);

  // git emits a path relative to cwd in the main worktree (just ".git")
  // and an absolute path when invoked from a linked worktree. Resolve
  // both forms against the workspace so the result is consistently
  // absolute.
  const commonDir = path.resolve(absoluteWorkspace, raw);
  const commonRoot = path.dirname(commonDir);

  if (commonRoot === absoluteWorkspace || commonRoot === "" || commonRoot === "/") {
    // Either we're in the main worktree (commonRoot === workspace) or
    // resolution produced a degenerate result (empty / filesystem
    // root). Neither warrants a fallback.
    return ok({ commonRoot: absoluteWorkspace, isWorktree: false });
  }

  return ok({ commonRoot, isWorktree: true });
}

/**
 * Convert a `WorkspaceLocation` plus a markdownRoot segment (e.g.
 * `"knowledge"`) into the absolute path to the fallback markdown root.
 * Returns null when the location is not a worktree — callers wire a
 * fallback only when one is actually needed.
 */
export function buildFallbackMarkdownRoot(
  location: WorkspaceLocation | null,
  markdownRootSegment: string,
): string | null {
  if (location === null || !location.isWorktree) return null;
  return path.resolve(location.commonRoot, markdownRootSegment);
}

/**
 * StorageError variant for the rare case where a caller insists on a
 * non-null result. Exposed for test fixtures that want to assert on
 * the error type when git fails unexpectedly.
 */
export function workspaceResolutionFailed(reason: string): StorageError {
  return new StorageError(`Workspace resolution failed: ${reason}`);
}
