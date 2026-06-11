import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { StatCachedDirectoryReader } from "../../../src/core/stat-cache.js";
import { ok, err } from "../../../src/core/result.js";
import type { Result } from "../../../src/core/result.js";
import { NotFoundError, StorageError } from "../../../src/core/errors.js";

/**
 * H1 — stat-based directory cache.
 *
 * Every knowledge lookup used to re-parse the whole corpus (readdir +
 * readFile + parseMarkdown per file). The cache keeps parsed values keyed
 * by absolute path and revalidates with a per-operation stat sweep
 * (mtimeMs/ctimeMs/size/ino): only changed files re-parse. Multi-process
 * safety comes from the stat check itself (CLI and MCP server share the
 * files) plus a racy window à la git: an entry cached while its mtime was
 * too recent is distrusted, killing timestamp-granularity races.
 */

interface ParsedFile {
  file: string;
  content: string;
}

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-statcache-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * Parse fn that counts invocations per path. Content sentinel "CORRUPT"
 * yields a StorageError, "GONE" a NotFoundError (simulates a file that
 * vanished between readdir and read).
 */
function countingParser(): {
  parse: (filePath: string) => Promise<Result<ParsedFile, NotFoundError | StorageError>>;
  counts: Map<string, number>;
  total: () => number;
} {
  const counts = new Map<string, number>();
  return {
    counts,
    total: () => [...counts.values()].reduce((a, b) => a + b, 0),
    parse: async (filePath: string) => {
      counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
      let raw: string;
      try {
        raw = await fs.readFile(filePath, "utf-8");
      } catch {
        return err(new NotFoundError("ParsedFile", path.basename(filePath)));
      }
      if (raw.startsWith("CORRUPT")) {
        return err(new StorageError(`Failed to parse: ${filePath}`));
      }
      if (raw.startsWith("GONE")) {
        return err(new NotFoundError("ParsedFile", path.basename(filePath)));
      }
      return ok({ file: path.basename(filePath), content: raw });
    },
  };
}

async function seed(name: string, content: string): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

describe("StatCachedDirectoryReader", () => {
  it("parses every .md file on the first read and returns readdir order", async () => {
    await seed("b.md", "beta");
    await seed("a.md", "alpha");
    const { parse, total } = countingParser();
    const reader = new StatCachedDirectoryReader<ParsedFile>(parse, { racyWindowMs: 0 });

    const result = await reader.readDir(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(total()).toBe(2);
    const diskOrder = (await fs.readdir(dir)).filter((e) => e.endsWith(".md"));
    expect(result.value.map((v) => v.file)).toEqual(diskOrder);
  });

  it("does not re-parse unchanged files on a second read", async () => {
    await seed("a.md", "alpha");
    await seed("b.md", "beta");
    const { parse, total } = countingParser();
    const reader = new StatCachedDirectoryReader<ParsedFile>(parse, { racyWindowMs: 0 });

    await reader.readDir(dir);
    const second = await reader.readDir(dir);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.map((v) => v.content).sort()).toEqual(["alpha", "beta"]);
    expect(total()).toBe(2);
  });

  it("re-parses only the file that changed", async () => {
    const aPath = await seed("a.md", "alpha");
    await seed("b.md", "beta");
    const { parse, counts } = countingParser();
    const reader = new StatCachedDirectoryReader<ParsedFile>(parse, { racyWindowMs: 0 });

    await reader.readDir(dir);
    await fs.writeFile(aPath, "alpha-v2", "utf-8");
    const second = await reader.readDir(dir);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const a = second.value.find((v) => v.file === "a.md");
    expect(a?.content).toBe("alpha-v2");
    expect(counts.get(aPath)).toBe(2);
    expect(counts.get(path.join(dir, "b.md"))).toBe(1);
  });

  it("drops deleted files from the results (no phantoms)", async () => {
    const aPath = await seed("a.md", "alpha");
    await seed("b.md", "beta");
    const { parse } = countingParser();
    const reader = new StatCachedDirectoryReader<ParsedFile>(parse, { racyWindowMs: 0 });

    await reader.readDir(dir);
    await fs.rm(aPath);
    const second = await reader.readDir(dir);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.map((v) => v.file)).toEqual(["b.md"]);
  });

  it("picks up files created after the first read", async () => {
    await seed("a.md", "alpha");
    const { parse } = countingParser();
    const reader = new StatCachedDirectoryReader<ParsedFile>(parse, { racyWindowMs: 0 });

    await reader.readDir(dir);
    await seed("c.md", "gamma");
    const second = await reader.readDir(dir);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.map((v) => v.content).sort()).toEqual(["alpha", "gamma"]);
  });

  it("reads a missing directory as empty", async () => {
    const { parse, total } = countingParser();
    const reader = new StatCachedDirectoryReader<ParsedFile>(parse, { racyWindowMs: 0 });

    const result = await reader.readDir(path.join(dir, "does-not-exist"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
    expect(total()).toBe(0);
  });

  it("ignores files without the configured extension", async () => {
    await seed("a.md", "alpha");
    await seed("notes.txt", "not me");
    const { parse, total } = countingParser();
    const reader = new StatCachedDirectoryReader<ParsedFile>(parse, { racyWindowMs: 0 });

    const result = await reader.readDir(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((v) => v.file)).toEqual(["a.md"]);
    expect(total()).toBe(1);
  });

  it("propagates a parse failure and does not cache it", async () => {
    const aPath = await seed("a.md", "CORRUPT yaml");
    const { parse } = countingParser();
    const reader = new StatCachedDirectoryReader<ParsedFile>(parse, { racyWindowMs: 0 });

    const first = await reader.readDir(dir);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.error).toBeInstanceOf(StorageError);

    // Repairing the file must be observed: the failure was never cached.
    await fs.writeFile(aPath, "repaired", "utf-8");
    const second = await reader.readDir(dir);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value[0]?.content).toBe("repaired");
  });

  it("skips files whose parse reports NotFound (vanished mid-read)", async () => {
    await seed("a.md", "alpha");
    await seed("ghost.md", "GONE");
    const { parse } = countingParser();
    const reader = new StatCachedDirectoryReader<ParsedFile>(parse, { racyWindowMs: 0 });

    const result = await reader.readDir(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((v) => v.file)).toEqual(["a.md"]);
  });

  it("invalidate(path) forces a re-parse of that file only", async () => {
    const aPath = await seed("a.md", "alpha");
    const bPath = await seed("b.md", "beta");
    const { parse, counts } = countingParser();
    const reader = new StatCachedDirectoryReader<ParsedFile>(parse, { racyWindowMs: 0 });

    await reader.readDir(dir);
    reader.invalidate(aPath);
    const second = await reader.readDir(dir);

    expect(second.ok).toBe(true);
    expect(counts.get(aPath)).toBe(2);
    expect(counts.get(bPath)).toBe(1);
  });

  it("re-parses entries that were cached inside the racy window", async () => {
    // A huge racy window means every entry's mtime is always "too recent"
    // relative to when it was cached — the reader must distrust the cache
    // and re-parse on every read. This pins the racy-git-style guard that
    // protects against same-timestamp rewrites the stat check cannot see.
    await seed("a.md", "alpha");
    const { parse, total } = countingParser();
    const reader = new StatCachedDirectoryReader<ParsedFile>(parse, {
      racyWindowMs: 1_000_000_000,
    });

    await reader.readDir(dir);
    await reader.readDir(dir);

    expect(total()).toBe(2);
  });

  it("pruning is scoped to the directory being read", async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-statcache-other-"));
    try {
      const aPath = await seed("a.md", "alpha");
      const otherPath = path.join(otherDir, "z.md");
      await fs.writeFile(otherPath, "zeta", "utf-8");
      const { parse, counts } = countingParser();
      const reader = new StatCachedDirectoryReader<ParsedFile>(parse, { racyWindowMs: 0 });

      await reader.readDir(dir);
      await reader.readDir(otherDir);
      // Deleting a.md and re-reading `dir` must not evict otherDir's entry.
      await fs.rm(aPath);
      await reader.readDir(dir);
      const other = await reader.readDir(otherDir);

      expect(other.ok).toBe(true);
      if (!other.ok) return;
      expect(other.value.map((v) => v.content)).toEqual(["zeta"]);
      expect(counts.get(otherPath)).toBe(1);
    } finally {
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  it("labels readdir failures with the configured entity label", async () => {
    const filePath = await seed("a.md", "alpha");
    const { parse } = countingParser();
    const reader = new StatCachedDirectoryReader<ParsedFile>(parse, {
      racyWindowMs: 0,
      entityLabel: "knowledge articles",
    });

    // readdir on a regular file fails with ENOTDIR — a non-ENOENT error.
    const result = await reader.readDir(filePath);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(StorageError);
    expect(result.error.message).toBe(`Failed to list knowledge articles in ${filePath}`);
  });
});
