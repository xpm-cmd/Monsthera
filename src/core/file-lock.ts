import * as fs from "node:fs/promises";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { StorageError } from "./errors.js";
import type { Result } from "./result.js";
import { err } from "./result.js";

/**
 * Default lock options tuned for local file-backed repositories.
 *
 * - `stale: 30s`    — a lock left over from a crashed process is forcibly
 *                     released after this window. Long enough for a slow
 *                     write, short enough that a stuck CLI doesn't block
 *                     a parallel agent forever.
 * - `retries`       — exponential backoff up to ~2.5s total. Real
 *                     contention from concurrent agents resolves quickly;
 *                     pathological contention surfaces as an error rather
 *                     than blocking forever.
 * - `realpath: false` — needed because the file may not exist yet
 *                     (proper-lockfile resolves the realpath of the
 *                     target file by default).
 */
const DEFAULT_LOCK_OPTIONS = {
  stale: 30_000,
  retries: { retries: 50, factor: 1.4, minTimeout: 20, maxTimeout: 250 },
  realpath: false,
} as const;

/**
 * Acquire an advisory file lock on `targetPath`, run `fn`, and release the
 * lock on completion (or failure). Returns `fn`'s Result, or wraps a
 * lock-acquisition failure as `StorageError`.
 *
 * The lock is keyed on `targetPath` itself: the lockfile lives next to it
 * as `<targetPath>.lock`. This serializes every read-modify-write on a
 * single article without serializing unrelated articles.
 *
 * If the parent directory does not yet exist (e.g. first write to a brand
 * new category), it is created so the lockfile has somewhere to live.
 */
export async function withFileLock<T, E>(
  targetPath: string,
  fn: () => Promise<Result<T, E>>,
): Promise<Result<T, E | StorageError>> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  // Ensure the target file exists for proper-lockfile to attach to —
  // the library refuses to lock a path that doesn't resolve to a file.
  // We touch it with O_CREAT and an empty body only if absent, leaving
  // existing content untouched.
  try {
    const handle = await fs.open(targetPath, "a");
    await handle.close();
  } catch (error) {
    return err(
      new StorageError(`Failed to prepare lock target: ${targetPath}`, { cause: String(error) }),
    );
  }

  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(targetPath, DEFAULT_LOCK_OPTIONS);
  } catch (error) {
    return err(
      new StorageError(`Failed to acquire file lock: ${targetPath}`, { cause: String(error) }),
    );
  }

  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      // Lock release failures are non-fatal — proper-lockfile's stale
      // detection will reclaim it after the configured window. Swallow
      // here so we don't mask the actual fn() result.
    }
  }
}
