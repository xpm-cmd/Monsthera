import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Stats } from "node:fs";
import { ok, err } from "./result.js";
import type { Result } from "./result.js";
import { NotFoundError, StorageError } from "./errors.js";

interface CacheEntry<T> {
  value: T;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
  /** Wall-clock ms when this entry was parsed (racy-window reference). */
  cachedAt: number;
}

export interface StatCachedDirectoryReaderOptions {
  /** File extension to include (default ".md"). */
  extension?: string;
  /** Noun used in readdir error messages, e.g. "knowledge articles". */
  entityLabel?: string;
  /**
   * Entries cached while their mtime was within this window of the caching
   * moment are distrusted and re-parsed on the next read — a same-timestamp
   * rewrite is invisible to the stat compare (racy-git problem). 0 disables
   * the guard (tests that pin parse counts need determinism).
   */
  racyWindowMs?: number;
}

const DEFAULT_RACY_WINDOW_MS = 2000;

/**
 * Directory reader that caches parsed file values in-process and
 * revalidates with a per-operation stat sweep: readdir + fs.stat per file,
 * re-parsing only entries whose (mtimeMs, ctimeMs, size, ino) changed.
 * Writers in OTHER processes (CLI vs MCP server, Option-A corpus drop-ins)
 * are detected by the stat check itself — no TTL, no watcher, no
 * single-writer assumption. Own writes should call `invalidate(path)`.
 */
export class StatCachedDirectoryReader<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly extension: string;
  private readonly entityLabel: string;
  private readonly racyWindowMs: number;

  constructor(
    private readonly parse: (filePath: string) => Promise<Result<T, NotFoundError | StorageError>>,
    options: StatCachedDirectoryReaderOptions = {},
  ) {
    this.extension = options.extension ?? ".md";
    this.entityLabel = options.entityLabel ?? "files";
    this.racyWindowMs = options.racyWindowMs ?? DEFAULT_RACY_WINDOW_MS;
  }

  /** Drop the cached entry for a path (call after writing/deleting it). */
  invalidate(filePath: string): void {
    this.entries.delete(path.resolve(filePath));
  }

  async readDir(dir: string): Promise<Result<T[], StorageError>> {
    const resolvedDir = path.resolve(dir);

    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Directory gone ⇒ its files are gone; keep entries from other dirs.
        this.pruneDir(resolvedDir, new Set());
        return ok([]);
      }
      return err(new StorageError(`Failed to list ${this.entityLabel} in ${dir}`, { cause: String(error) }));
    }

    const seen = new Set<string>();
    const values: T[] = [];

    for (const name of names) {
      if (!name.endsWith(this.extension)) continue;
      const filePath = path.join(dir, name);
      const key = path.resolve(filePath);

      let stat: Stats | null;
      try {
        stat = await fs.stat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          // Vanished between readdir and stat — same as a missing file.
          this.entries.delete(key);
          continue;
        }
        // Unexpected stat failure: let the parse path classify the error
        // instead of inventing new failure semantics here.
        stat = null;
      }

      const cached = this.entries.get(key);
      if (cached !== undefined && stat !== null && this.isTrustedHit(cached, stat)) {
        seen.add(key);
        values.push(cached.value);
        continue;
      }

      const parsed = await this.parse(filePath);
      if (!parsed.ok) {
        if (parsed.error instanceof NotFoundError) {
          this.entries.delete(key);
          continue;
        }
        // Failures are never cached: a repaired file must be observed.
        return err(parsed.error);
      }

      if (stat !== null) {
        this.entries.set(key, {
          value: parsed.value,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          size: stat.size,
          ino: stat.ino,
          cachedAt: Date.now(),
        });
      } else {
        this.entries.delete(key);
      }
      seen.add(key);
      values.push(parsed.value);
    }

    this.pruneDir(resolvedDir, seen);
    return ok(values);
  }

  private isTrustedHit(cached: CacheEntry<T>, stat: Stats): boolean {
    if (
      stat.mtimeMs !== cached.mtimeMs ||
      stat.ctimeMs !== cached.ctimeMs ||
      stat.size !== cached.size ||
      stat.ino !== cached.ino
    ) {
      return false;
    }
    if (this.racyWindowMs <= 0) return true;
    // Cached while the file was still "hot": a rewrite inside the same
    // timestamp granule would be invisible to the compare above. Distrust
    // until a re-parse re-stamps cachedAt comfortably after mtime.
    return cached.mtimeMs < cached.cachedAt - this.racyWindowMs;
  }

  private pruneDir(resolvedDir: string, seen: Set<string>): void {
    for (const key of this.entries.keys()) {
      if (path.dirname(key) === resolvedDir && !seen.has(key)) {
        this.entries.delete(key);
      }
    }
  }
}
