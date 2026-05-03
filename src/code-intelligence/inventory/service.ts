/**
 * `CodeInventoryService` — the service-layer composition for ADR-017 M3.
 *
 * Responsibilities:
 *   - Drive a `SymbolExtractor` (default: `TextMateSymbolExtractor`) over a
 *     concrete list of paths supplied by the caller. Glob expansion lives
 *     in the CLI (Phase 3); the service receives final paths.
 *   - Persist the snapshot via `JsonInventoryPersistence` (JSON + optional
 *     Dolt mirror).
 *   - Maintain an in-memory map keyed by path, with **lazy mtime-per-file
 *     revalidation** (ADR-017 D5). Every `query` and `getSymbolsForFile`
 *     compares recorded `mtimeMs` against the current file's mtime; on
 *     change, the file is re-extracted and the in-memory entry is
 *     replaced. A debounced flush persists the change without serialising
 *     the whole snapshot on every keystroke.
 *
 * Out of scope here:
 *   - Walking the filesystem. The service receives paths; the CLI shells
 *     `git ls-files` and feeds them in.
 *   - Wiring into the container. Phase 3 lands that.
 *   - Knowing about `code_get_ref` / `code_find_owners`. Those are Phase 4.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { StorageError } from "../../core/errors.js";
import type { Logger } from "../../core/logger.js";
import type { Result } from "../../core/result.js";
import { ok } from "../../core/result.js";

import {
  TextMateSymbolExtractor,
  type SymbolExtractor,
} from "./extractor.js";
import { languageForExtension } from "./language-map.js";
import {
  JsonInventoryPersistence,
  type DoltMirrorClient,
  type JsonInventoryPersistenceOptions,
} from "./persistence.js";
import type {
  CodeArtifact,
  CodeInventoryFileEntry,
  CodeInventorySnapshot,
  CodeInventoryStatus,
  CodeQueryHit,
  CodeQueryInput,
  CodeQueryResult,
} from "./types.js";

/** Files larger than this skip extraction entirely (ADR-017 D5 / open Q2). */
const MAX_FILE_BYTES = 1_048_576; // 1 MB
/** Bytes inspected at the start of each file for null-byte binary detection. */
const BINARY_PROBE_BYTES = 4096;

const DEFAULT_DEBOUNCE_MS = 250;
const SCHEMA_VERSION = 1 as const;

export interface CodeInventoryServiceOptions {
  /** Repository root. Cache file lands at `<repoPath>/.monsthera/cache/code-index.json`. */
  readonly repoPath: string;
  readonly logger: Logger;
  /** `null` when Dolt is disabled or unavailable — the mirror is skipped. */
  readonly doltClient: DoltMirrorClient | null;
  /** Override for unit tests. Defaults to `TextMateSymbolExtractor`. */
  readonly extractor?: SymbolExtractor;
  /** Override for unit tests. Defaults to a `JsonInventoryPersistence` under `<repoPath>/.monsthera/cache/`. */
  readonly persistence?: JsonInventoryPersistence;
  /**
   * Debounce window for the lazy-flush after stale-file revalidation.
   * Tests pass `0` to drain the writer queue synchronously (well, on the
   * next microtask). Production keeps the default so a burst of queries
   * doesn't trigger N JSON writes.
   */
  readonly debounceMs?: number;
}

export interface BuildInput {
  /**
   * Concrete paths to extract from. Relative to `repoPath`. The caller
   * (CLI) is responsible for `.gitignore` filtering and any glob
   * expansion. The service applies its own pre-extraction filters
   * (skip symlinks, skip files >1 MB, skip binaries).
   */
  readonly paths: readonly string[];
}

export interface ReindexInput {
  /** Same shape as `BuildInput.paths`. */
  readonly paths: readonly string[];
  /**
   * `true` → wipe the cache and rebuild from scratch.
   * `false` (default) → reuse the existing snapshot for unchanged files;
   * extract only files whose mtime differs or that are new.
   */
  readonly full?: boolean;
}

/**
 * Default cache path. Exposed so tests and the Phase 3 wiring can compute
 * the same location without re-deriving.
 */
export function defaultCacheFile(repoPath: string): string {
  return path.resolve(repoPath, ".monsthera/cache/code-index.json");
}

interface InMemoryState {
  readonly builtAt: string;
  readonly repoFingerprint: string;
  readonly files: Map<string, CodeInventoryFileEntry>;
}

export class CodeInventoryService {
  private readonly logger: Logger;
  private readonly repoPath: string;
  private readonly extractor: SymbolExtractor;
  private readonly persistence: JsonInventoryPersistence;
  private readonly debounceMs: number;

  /** Lazy in-memory state. `null` until the first `build` or successful `load`. */
  private state: InMemoryState | null = null;
  /**
   * `true` once we've checked persistence at least once, so subsequent
   * queries don't re-read `code-index.json` from disk on every call.
   * Loading is idempotent but not free.
   */
  private loadedFromDisk = false;

  /** Set when the most recent save reported a Dolt mirror failure. */
  private mirrorDegraded: { reason: string } | undefined;

  /** Pending debounced flush handle. Cleared on every drain. */
  private flushTimer: NodeJS.Timeout | null = null;
  /** Tracks an in-flight flush so concurrent queries don't queue duplicates. */
  private flushPromise: Promise<Result<void, StorageError>> | null = null;
  /** Tracks the most recent error from a debounced flush so callers can surface it. */
  private lastFlushError: StorageError | null = null;

  constructor(options: CodeInventoryServiceOptions) {
    this.logger = options.logger;
    this.repoPath = path.resolve(options.repoPath);
    this.extractor = options.extractor ?? new TextMateSymbolExtractor(options.logger);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

    const persistenceOptions: JsonInventoryPersistenceOptions = {
      cacheFile: defaultCacheFile(this.repoPath),
      logger: options.logger,
      doltClient: options.doltClient,
    };
    this.persistence = options.persistence ?? new JsonInventoryPersistence(persistenceOptions);
  }

  // ─── Public API ─────────────────────────────────────────────────────────

  /**
   * Cold build over a concrete list of paths. Replaces any existing
   * snapshot. Filters applied per file: skip symlinks, skip files >1 MB,
   * skip files whose first 4 KB contains a null byte.
   *
   * Files in unknown languages are recorded as file-level entries with no
   * symbols (ADR-017 D3 — degraded path).
   */
  async build(input: BuildInput): Promise<Result<CodeInventorySnapshot, StorageError>> {
    const files = await this.extractAll(input.paths);
    const snapshot: CodeInventorySnapshot = {
      schemaVersion: SCHEMA_VERSION,
      builtAt: new Date().toISOString(),
      repoFingerprint: this.computeFingerprint(files),
      files,
    };

    const writeResult = await this.persistence.save(snapshot);
    if (!writeResult.ok) return writeResult;
    this.mirrorDegraded = writeResult.value.mirrorDegraded;

    this.state = {
      builtAt: snapshot.builtAt,
      repoFingerprint: snapshot.repoFingerprint,
      files: new Map(files.map((file) => [file.path, file])),
    };
    this.loadedFromDisk = true;

    return ok(snapshot);
  }

  /**
   * Run a structured query against the in-memory inventory. Performs
   * lazy mtime revalidation on every file that would surface in the
   * results — out-of-date entries are re-extracted before ranking.
   *
   * When the inventory has not been built, returns an empty result with
   * the documented `recommendedNextActions` hint (ADR-017 D6).
   */
  async query(input: CodeQueryInput): Promise<Result<CodeQueryResult, StorageError>> {
    const ensureResult = await this.ensureLoaded();
    if (!ensureResult.ok) return ensureResult;

    if (!this.state) {
      return ok({
        query: input.query,
        hits: [],
        summary: { hitCount: 0, languageCount: 0, fileCount: 0 },
        recommendedNextActions: [
          "Inventory has not been built yet. Run monsthera code reindex to build it.",
        ],
      });
    }

    await this.revalidateAll();

    const limit = input.limit ?? 50;
    const tokens = tokenize(input.query);
    const kindFilter = input.kinds ? new Set(input.kinds) : null;
    const langFilter = input.languages ? new Set(input.languages) : null;
    const pathFilter = input.paths ?? null;

    const hits: CodeQueryHit[] = [];
    const fileMatches = new Set<string>();
    const langMatches = new Set<string>();

    for (const file of this.state.files.values()) {
      if (pathFilter && !matchesPath(file.path, pathFilter)) continue;
      if (langFilter && !langFilter.has(file.language ?? "unknown")) continue;

      // Implicit "kind: file" entries match the query when the requested
      // kinds include "file" and the path-or-basename token-overlaps.
      if ((!kindFilter || kindFilter.has("file")) && tokens.length > 0) {
        const fileScore = scoreString(path.basename(file.path), tokens, file.path);
        if (fileScore > 0) {
          hits.push({
            path: file.path,
            symbol: path.basename(file.path),
            kind: "file",
            language: file.language,
            score: fileScore,
          });
          fileMatches.add(file.path);
          if (file.language) langMatches.add(file.language);
        }
      }

      for (const symbol of file.symbols) {
        if (kindFilter && !kindFilter.has(symbol.kind)) continue;
        const score = scoreString(symbol.name, tokens, file.path);
        if (score <= 0) continue;
        hits.push({
          path: file.path,
          symbol: symbol.name,
          kind: symbol.kind,
          language: symbol.language ?? file.language,
          line: symbol.startLine,
          scope: symbol.scope,
          score,
        });
        fileMatches.add(file.path);
        const lang = symbol.language ?? file.language;
        if (lang) langMatches.add(lang);
      }
    }

    hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.symbol.localeCompare(b.symbol));
    const limited = hits.slice(0, limit);

    const recommended = this.recommendForQuery(limited.length);

    return ok({
      query: input.query,
      hits: limited,
      summary: {
        hitCount: limited.length,
        languageCount: langMatches.size,
        fileCount: fileMatches.size,
      },
      recommendedNextActions: recommended,
    });
  }

  /**
   * Read-only status surface. Never triggers a build; returns
   * `built: false` when the cache hasn't been created yet (ADR-017 D8 / D9).
   */
  async getStatus(): Promise<Result<CodeInventoryStatus, StorageError>> {
    const ensureResult = await this.ensureLoaded();
    if (!ensureResult.ok) return ensureResult;

    if (!this.state) {
      return ok({
        built: false,
        fileCount: 0,
        symbolCount: 0,
        languages: [],
      });
    }

    let symbolCount = 0;
    let staleFileCount = 0;
    const languages = new Set<string>();
    for (const file of this.state.files.values()) {
      symbolCount += file.symbols.length;
      if (file.language) languages.add(file.language);
      if (this.isStaleOnDisk(file)) staleFileCount += 1;
    }

    return ok({
      built: true,
      fileCount: this.state.files.size,
      symbolCount,
      languages: [...languages].sort(),
      lastReindexAt: this.state.builtAt,
      staleFileCount,
      degraded: this.mirrorDegraded,
    });
  }

  /**
   * Reindex the inventory.
   *
   * - `full: true` — wipes the cache and rebuilds from scratch.
   * - `full: false` (default) — incremental: keep entries for unchanged
   *   files (mtime + size match), re-extract entries whose mtime changed,
   *   add entries for paths not previously seen.
   */
  async reindex(
    input: ReindexInput,
  ): Promise<Result<CodeInventoryStatus, StorageError>> {
    if (input.full) {
      const clearResult = await this.persistence.clear();
      if (!clearResult.ok) return clearResult;
      this.state = null;
      this.loadedFromDisk = true;
      const built = await this.build({ paths: input.paths });
      if (!built.ok) return built;
      return this.getStatus();
    }

    const ensureResult = await this.ensureLoaded();
    if (!ensureResult.ok) return ensureResult;

    const previous = this.state;
    const updatedFiles: CodeInventoryFileEntry[] = [];
    for (const filePath of input.paths) {
      const absolute = this.absolutise(filePath);
      const stat = this.statSafely(absolute);
      if (!stat) continue;
      if (!this.passesPreExtractionFilter(absolute, stat)) continue;

      const previousEntry = previous?.files.get(filePath);
      if (
        previousEntry &&
        previousEntry.mtimeMs === stat.mtimeMs &&
        previousEntry.sizeBytes === stat.size
      ) {
        updatedFiles.push(previousEntry);
        continue;
      }

      const entry = await this.extractFile(filePath, absolute, stat);
      if (entry) updatedFiles.push(entry);
    }

    const snapshot: CodeInventorySnapshot = {
      schemaVersion: SCHEMA_VERSION,
      builtAt: new Date().toISOString(),
      repoFingerprint: this.computeFingerprint(updatedFiles),
      files: updatedFiles,
    };

    const writeResult = await this.persistence.save(snapshot);
    if (!writeResult.ok) return writeResult;
    this.mirrorDegraded = writeResult.value.mirrorDegraded;

    this.state = {
      builtAt: snapshot.builtAt,
      repoFingerprint: snapshot.repoFingerprint,
      files: new Map(updatedFiles.map((f) => [f.path, f])),
    };
    this.loadedFromDisk = true;
    return this.getStatus();
  }

  /**
   * Lookup symbols for a single file. Triggers a re-extraction when the
   * recorded mtime is stale. Returns `[]` for unknown paths or files
   * outside the inventory's pre-extraction filters.
   */
  async getSymbolsForFile(
    filePath: string,
  ): Promise<Result<readonly CodeArtifact[], StorageError>> {
    const ensureResult = await this.ensureLoaded();
    if (!ensureResult.ok) return ensureResult;
    if (!this.state) return ok([]);

    const entry = this.state.files.get(filePath);
    if (!entry) return ok([]);

    const refreshed = await this.revalidateEntry(entry);
    if (!refreshed) return ok([]);
    return ok(refreshed.symbols);
  }

  /**
   * Force any pending debounced flush to complete. Tests use this to
   * drain the writer queue without waiting on a timer.
   */
  async flush(): Promise<Result<void, StorageError>> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushPromise) return this.flushPromise;
    if (!this.state) return ok(undefined);
    return this.persistInPlace();
  }

  /** Surface the most recent debounced-flush error, if any. Tests rely on this. */
  takeFlushError(): StorageError | null {
    const e = this.lastFlushError;
    this.lastFlushError = null;
    return e;
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async ensureLoaded(): Promise<Result<void, StorageError>> {
    if (this.loadedFromDisk) return ok(undefined);
    const loaded = await this.persistence.load();
    if (!loaded.ok) return loaded;
    if (loaded.value) {
      this.state = {
        builtAt: loaded.value.builtAt,
        repoFingerprint: loaded.value.repoFingerprint,
        files: new Map(loaded.value.files.map((file) => [file.path, file])),
      };
    }
    this.loadedFromDisk = true;
    return ok(undefined);
  }

  private async revalidateAll(): Promise<void> {
    if (!this.state) return;
    let changed = false;
    for (const entry of [...this.state.files.values()]) {
      const refreshed = await this.revalidateEntry(entry);
      if (refreshed === null) {
        // File disappeared since the last build — drop it from memory.
        this.state.files.delete(entry.path);
        changed = true;
      } else if (refreshed !== entry) {
        changed = true;
      }
    }
    if (changed) this.scheduleFlush();
  }

  /**
   * Compare the recorded mtime/size against the on-disk file. If they
   * match, returns the existing entry unchanged. If the file changed,
   * re-extracts and replaces the entry in-place. If the file disappeared
   * or fails the pre-extraction filter, returns `null` to signal removal.
   */
  private async revalidateEntry(
    entry: CodeInventoryFileEntry,
  ): Promise<CodeInventoryFileEntry | null> {
    const absolute = this.absolutise(entry.path);
    const stat = this.statSafely(absolute);
    if (!stat) return null;
    if (!this.passesPreExtractionFilter(absolute, stat)) return null;
    if (entry.mtimeMs === stat.mtimeMs && entry.sizeBytes === stat.size) {
      return entry;
    }

    const refreshed = await this.extractFile(entry.path, absolute, stat);
    if (!refreshed) return null;
    if (this.state) this.state.files.set(entry.path, refreshed);
    this.scheduleFlush();
    return refreshed;
  }

  private async extractAll(
    paths: readonly string[],
  ): Promise<readonly CodeInventoryFileEntry[]> {
    const out: CodeInventoryFileEntry[] = [];
    for (const filePath of paths) {
      const absolute = this.absolutise(filePath);
      const stat = this.statSafely(absolute);
      if (!stat) continue;
      if (!this.passesPreExtractionFilter(absolute, stat)) continue;
      const entry = await this.extractFile(filePath, absolute, stat);
      if (entry) out.push(entry);
    }
    return out;
  }

  /**
   * Read + extract a single file. Returns `null` if reading failed
   * (transient I/O — already filtered above for stable conditions like
   * symlinks and binaries).
   */
  private async extractFile(
    relativePath: string,
    absolutePath: string,
    stat: fs.Stats,
  ): Promise<CodeInventoryFileEntry | null> {
    const ext = path.extname(relativePath);
    const language = languageForExtension(ext);
    let symbols: readonly CodeArtifact[] = [];

    if (language) {
      let content: string;
      try {
        content = await fsp.readFile(absolutePath, "utf-8");
      } catch (cause) {
        this.logger.debug("inventory: failed to read file", {
          path: relativePath,
          cause: String(cause),
        });
        return null;
      }
      try {
        symbols = await this.extractor.extract({
          path: relativePath,
          content,
        });
      } catch (cause) {
        // The extractor contract says it never throws, but defend in
        // depth — never let one malformed file abort the build.
        this.logger.debug("inventory: extractor threw", {
          path: relativePath,
          cause: cause instanceof Error ? cause.message : String(cause),
        });
        symbols = [];
      }
    }

    return {
      path: relativePath,
      language: language ?? undefined,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      symbols,
    };
  }

  /**
   * Pre-extraction filter (ADR-017 open Q1 + Q2): skip symlinks, skip
   * files >1 MB, skip files whose first 4 KB contains a null byte
   * (binary heuristic). All three are conservative — false positives
   * (a text file mistaken for binary) are rare and self-correct on the
   * next build with a refined heuristic; false negatives would crash
   * the extractor on giant minified bundles or binary blobs.
   */
  private passesPreExtractionFilter(absolutePath: string, stat: fs.Stats): boolean {
    if (stat.isSymbolicLink()) return false;
    if (!stat.isFile()) return false;
    if (stat.size > MAX_FILE_BYTES) return false;
    if (stat.size === 0) return true;
    if (this.looksBinary(absolutePath, stat.size)) return false;
    return true;
  }

  private looksBinary(absolutePath: string, fileSize: number): boolean {
    let fd: number | null = null;
    try {
      fd = fs.openSync(absolutePath, "r");
      const probeLen = Math.min(BINARY_PROBE_BYTES, fileSize);
      const buf = Buffer.alloc(probeLen);
      const read = fs.readSync(fd, buf, 0, probeLen, 0);
      for (let i = 0; i < read; i++) {
        if (buf[i] === 0) return true;
      }
      return false;
    } catch (cause) {
      this.logger.debug("inventory: binary probe failed", {
        path: absolutePath,
        cause: String(cause),
      });
      return true; // err on the side of skipping unreadable files
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore — fd already closed or never opened
        }
      }
    }
  }

  private statSafely(absolutePath: string): fs.Stats | null {
    try {
      return fs.lstatSync(absolutePath);
    } catch {
      return null;
    }
  }

  private isStaleOnDisk(entry: CodeInventoryFileEntry): boolean {
    const stat = this.statSafely(this.absolutise(entry.path));
    if (!stat) return true;
    return stat.mtimeMs !== entry.mtimeMs || stat.size !== entry.sizeBytes;
  }

  private absolutise(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(this.repoPath, filePath);
  }

  /**
   * Cheap deterministic fingerprint over the snapshot. Not a content
   * hash — concatenates each file's path and mtime. Used by the
   * persistence layer's load() to detect a snapshot from a different
   * working tree.
   */
  private computeFingerprint(files: readonly CodeInventoryFileEntry[]): string {
    let acc = 0;
    for (const file of files) {
      // Tiny FNV-ish accumulation. Two files with the same path/mtime
      // produce the same contribution; the goal is fingerprint stability,
      // not cryptographic uniqueness.
      for (let i = 0; i < file.path.length; i++) {
        acc = (acc * 31 + file.path.charCodeAt(i)) >>> 0;
      }
      acc = (acc ^ Math.floor(file.mtimeMs)) >>> 0;
    }
    return `fp-${acc.toString(16)}-${files.length}`;
  }

  private recommendForQuery(hitCount: number): readonly string[] {
    const out: string[] = [];
    if (hitCount >= 3) {
      out.push(
        "Run build_context_pack on the top hit to retrieve linked Monsthera context.",
      );
    }
    if (this.state) {
      let staleCount = 0;
      for (const entry of this.state.files.values()) {
        if (this.isStaleOnDisk(entry)) staleCount += 1;
      }
      if (this.state.files.size > 0 && staleCount * 10 >= this.state.files.size) {
        out.push(
          `Inventory has ${staleCount} stale entries; consider monsthera code reindex.`,
        );
      }
    }
    return out;
  }

  // ─── Debounced flush ────────────────────────────────────────────────────
  //
  // The contract: after a stale-mtime revalidation updates the in-memory
  // map, we want the change to land on disk eventually but not on every
  // single revalidation. A debounce window collapses bursts of changes
  // into a single write.

  private scheduleFlush(): void {
    if (this.debounceMs === 0) {
      // Immediate flush mode — used by tests so they don't have to wait
      // on a real timer. Still goes through `persistInPlace` so the
      // writer is exercised exactly the same way as in production.
      void this.persistInPlace().catch(() => undefined);
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.persistInPlace().catch(() => undefined);
    }, this.debounceMs);
    // Don't keep the event loop alive just for the flush — if the
    // process is shutting down, the next build will reconcile.
    if (typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  private async persistInPlace(): Promise<Result<void, StorageError>> {
    if (!this.state) return ok(undefined);
    if (this.flushPromise) return this.flushPromise;

    const snapshot: CodeInventorySnapshot = {
      schemaVersion: SCHEMA_VERSION,
      builtAt: this.state.builtAt,
      repoFingerprint: this.state.repoFingerprint,
      files: [...this.state.files.values()],
    };

    const promise = (async () => {
      const writeResult = await this.persistence.save(snapshot);
      if (!writeResult.ok) {
        this.lastFlushError = writeResult.error;
        return writeResult;
      }
      this.mirrorDegraded = writeResult.value.mirrorDegraded;
      return ok(undefined);
    })();
    this.flushPromise = promise;
    try {
      return await promise;
    } finally {
      this.flushPromise = null;
    }
  }
}

// ─── Free functions ────────────────────────────────────────────────────────

function tokenize(query: string): readonly string[] {
  // Split on non-identifier boundaries; keep CamelCase as one unit but
  // also expose its lowercased form so a query like "context pack" matches
  // a symbol named `buildContextPack`.
  const tokens: string[] = [];
  const trimmed = query.trim();
  if (!trimmed) return tokens;
  for (const raw of trimmed.split(/[^A-Za-z0-9_]+/g)) {
    if (raw.length === 0) continue;
    tokens.push(raw.toLowerCase());
  }
  return tokens;
}

function scoreString(name: string, tokens: readonly string[], filePath: string): number {
  if (tokens.length === 0) return 0;
  const lowerName = name.toLowerCase();
  const lowerPath = filePath.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (lowerName === token) score += 12;
    else if (lowerName.startsWith(token)) score += 8;
    else if (lowerName.includes(token)) score += 4;
    else if (lowerPath.includes(token)) score += 1;
    else return 0; // require every token to land somewhere
  }
  return score;
}

function matchesPath(filePath: string, filters: readonly string[]): boolean {
  // ADR-017 D4: path filters are exact OR directory-prefix. The caller
  // (CLI/dashboard) is responsible for any glob expansion before
  // reaching here.
  for (const filter of filters) {
    if (filePath === filter) return true;
    const withSlash = filter.endsWith("/") ? filter : `${filter}/`;
    if (filePath.startsWith(withSlash)) return true;
  }
  return false;
}

// Re-export types-of-interest so callers (Phase 3 wiring) can import from
// the service module without reaching into the persistence module.
export type { DoltMirrorClient, JsonInventoryPersistence };
export type { ArtifactKind } from "./types.js";
