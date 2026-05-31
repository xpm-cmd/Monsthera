import type { StorageError } from "../core/errors.js";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import type { CommandRunner } from "../ops/command-runner.js";
import type { SessionFactsCodeTouched, SessionFactsCommit } from "./schemas.js";

/**
 * Pure git-parsing helpers used by `DefaultFactsExtractor`.
 *
 * Each helper takes a `CommandRunner` and returns a `Result` — no class state,
 * no implicit dependency on the real shell. Tests inject a stub runner that
 * returns canned stdout for each git invocation.
 */

const DEFAULT_TIMEOUT_MS = (() => {
  const raw = process.env.MONSTHERA_FACTS_GIT_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
})();

export interface ResolveBaseShaOptions {
  readonly repo: string;
  readonly openedAt: string;
  readonly runner: CommandRunner;
  readonly timeoutMs?: number;
}

/**
 * Resolve the git commit SHA that was at the tip of HEAD at or before the
 * session opened. Returns `null` when no commit predates the window (fresh
 * repo, or session opened before any commit existed).
 */
export async function resolveBaseSha(
  options: ResolveBaseShaOptions,
): Promise<Result<string | null, StorageError>> {
  const result = await options.runner({
    command: "git",
    args: ["rev-list", "-1", `--before=${options.openedAt}`, "HEAD"],
    cwd: options.repo,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!result.ok) return err(result.error);
  const sha = result.value.stdout.trim();
  return ok(sha === "" ? null : sha);
}

export interface ListCommitsInWindowOptions {
  readonly repo: string;
  readonly openedAt: string;
  readonly closedAt: string;
  readonly runner: CommandRunner;
  readonly timeoutMs?: number;
}

/**
 * List git commits whose committer date falls in `[openedAt, closedAt]`.
 * Returns `ok([])` on git failure (missing binary, not a checkout) — callers
 * treat the absence of commits as a non-fatal condition.
 */
export interface ExtractDiffSignalsOptions {
  readonly repo: string;
  readonly baseSha: string;
  readonly runner: CommandRunner;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

export interface DiffSignalEntry {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface DiffSignals {
  readonly todosAdded: DiffSignalEntry[];
  readonly questions: DiffSignalEntry[];
}

const DIFF_MAX_BUFFER = 10 * 1024 * 1024;
const TODO_RE = /\b(?:TODO|FIXME|XXX|HACK)\b/i;
const QUESTION_RE = /\?\s*$/;

/**
 * Scan `git diff --unified=0 baseSha..HEAD` for TODO/FIXME/XXX/HACK markers
 * and `?`-ending lines on added (`+`) rows, attributing each match to the
 * file path (from `+++ b/<path>`) and new-file line (from the `@@ +N,M @@`
 * hunk header). Returns `{ todosAdded: [], questions: [] }` on git failure.
 */
export async function extractDiffSignals(
  options: ExtractDiffSignalsOptions,
): Promise<Result<DiffSignals, StorageError>> {
  const result = await options.runner({
    command: "git",
    args: ["diff", "--unified=0", `${options.baseSha}..HEAD`],
    cwd: options.repo,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBufferBytes: options.maxBufferBytes ?? DIFF_MAX_BUFFER,
  });
  if (!result.ok) return ok({ todosAdded: [], questions: [] });

  const todosAdded: DiffSignalEntry[] = [];
  const questions: DiffSignalEntry[] = [];
  let currentPath: string | null = null;
  let currentNewLine = 0;

  for (const raw of result.value.stdout.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      currentPath = raw.slice(6);
      currentNewLine = 0;
      continue;
    }
    if (raw.startsWith("+++ /dev/null") || raw.startsWith("---")) {
      if (raw.startsWith("+++ /dev/null")) currentPath = null;
      continue;
    }
    if (raw.startsWith("@@")) {
      const match = raw.match(/\+(\d+)(?:,\d+)?/);
      if (match && match[1]) currentNewLine = Number.parseInt(match[1], 10);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      if (currentPath !== null) {
        const text = raw.slice(1);
        const entry: DiffSignalEntry = { path: currentPath, line: currentNewLine, text };
        if (TODO_RE.test(text)) {
          todosAdded.push(entry);
        } else if (QUESTION_RE.test(text)) {
          questions.push(entry);
        }
      }
      currentNewLine += 1;
    }
  }
  return ok({ todosAdded, questions });
}

export interface ListCodeTouchedSinceBaseOptions {
  readonly repo: string;
  readonly baseSha: string;
  readonly runner: CommandRunner;
  readonly timeoutMs?: number;
}

/**
 * Aggregate per-file line deltas between `baseSha` and HEAD via
 * `git diff --numstat`. Binary files are kept (path captured, deltas = 0).
 * Renamed files (numstat `{old => new}` syntax) are skipped in v1.
 * Returns `ok([])` on git failure.
 */
export async function listCodeTouchedSinceBase(
  options: ListCodeTouchedSinceBaseOptions,
): Promise<Result<SessionFactsCodeTouched[], StorageError>> {
  const result = await options.runner({
    command: "git",
    args: ["diff", "--numstat", `${options.baseSha}..HEAD`],
    cwd: options.repo,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!result.ok) return ok([]);

  const touched: SessionFactsCodeTouched[] = [];
  for (const raw of result.value.stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [addedRaw, removedRaw, ...pathParts] = parts;
    if (addedRaw === undefined || removedRaw === undefined) continue;
    const path = pathParts.join("\t");
    if (!path) continue;
    if (path.includes("{") && path.includes("=>")) continue;
    const linesAdded = addedRaw === "-" ? 0 : Number.parseInt(addedRaw, 10);
    const linesRemoved = removedRaw === "-" ? 0 : Number.parseInt(removedRaw, 10);
    if (!Number.isFinite(linesAdded) || !Number.isFinite(linesRemoved)) continue;
    touched.push({ path, linesAdded, linesRemoved });
  }
  return ok(touched);
}

export async function listCommitsInWindow(
  options: ListCommitsInWindowOptions,
): Promise<Result<SessionFactsCommit[], StorageError>> {
  const result = await options.runner({
    command: "git",
    args: [
      "log",
      `--since=${options.openedAt}`,
      `--until=${options.closedAt}`,
      "--format=%H|%s|%cI",
    ],
    cwd: options.repo,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!result.ok) return ok([]);
  return ok(parseCommitLines(result.value.stdout));
}

export interface ListCommitsInRangeOptions {
  readonly repo: string;
  readonly range: string;
  readonly runner: CommandRunner;
  readonly timeoutMs?: number;
}

/**
 * List git commits in a revision `range` (e.g. `HEAD~5..HEAD`, `main..feature`)
 * via `git log <range> --format=%H|%s|%cI`, newest-first. Unlike
 * `listCommitsInWindow` (date-bounded, used by session facts where a missing
 * checkout is non-fatal), a git failure here returns `err` so a caller can
 * surface a bad range to the user — PR-15 ingestion treats it as a real error.
 */
export async function listCommitsInRange(
  options: ListCommitsInRangeOptions,
): Promise<Result<SessionFactsCommit[], StorageError>> {
  const result = await options.runner({
    command: "git",
    args: ["log", options.range, "--format=%H|%s|%cI"],
    cwd: options.repo,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });
  if (!result.ok) return err(result.error);
  return ok(parseCommitLines(result.value.stdout));
}

/** Parse `%H|%s|%cI` git-log lines into commits. Shared by the window + range helpers. */
function parseCommitLines(stdout: string): SessionFactsCommit[] {
  const commits: SessionFactsCommit[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const firstPipe = line.indexOf("|");
    const lastPipe = line.lastIndexOf("|");
    if (firstPipe === -1 || lastPipe === firstPipe) continue;
    const sha = line.slice(0, firstPipe);
    const subject = line.slice(firstPipe + 1, lastPipe);
    const timestamp = line.slice(lastPipe + 1);
    if (!sha || !subject || !timestamp) continue;
    commits.push({ sha, subject, timestamp });
  }
  return commits;
}
