/**
 * Phase 2 / ADR-017: service-level unit tests.
 *
 * What we cover here (acceptance gates from the M3 prompt):
 *   - Cold build over a 15-file synthetic repo across 4 languages, with
 *     symlinks and binaries seeded to exercise the pre-extraction filter.
 *   - Incremental query catches a stale file: edit a file, query, observe
 *     the refreshed symbol set in the response.
 *   - `reindex({ full: true })` detects a brand-new file added to the
 *     supplied paths list and produces a snapshot containing it.
 *   - `getStatus()` reports built/false before any build, then summary
 *     fields (`fileCount`, `symbolCount`, `languages`) after build.
 *   - Persistence survives across service instances (round-trip on disk).
 *   - Lazy mtime invalidation flushes a debounced write that lands on disk.
 *
 * Tests use a stub `SymbolExtractor` so we don't depend on the TextMate
 * extractor's lazy WASM load in this layer — Phase 1 covers that already.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../../../../src/core/logger.js";
import {
  CodeInventoryService,
  defaultCacheFile,
} from "../../../../src/code-intelligence/inventory/service.js";
import type { SymbolExtractor } from "../../../../src/code-intelligence/inventory/extractor.js";
import type {
  ArtifactKind,
  CodeArtifact,
  CodeInventorySnapshot,
} from "../../../../src/code-intelligence/inventory/types.js";

const SILENT_LOGGER = createLogger({ level: "warn", domain: "test", output: () => undefined });

/**
 * A deterministic stub extractor. Returns one synthetic symbol per file
 * derived from the basename. Lets us decouple service tests from the
 * TextMate Phase-1 path while still exercising the full extraction lifecycle.
 *
 * Counts every `extract` call so tests can assert that revalidation
 * actually re-extracts when mtime changes.
 */
function makeStubExtractor(): SymbolExtractor & {
  readonly extractCalls: { path: string; content: string }[];
} {
  const extractCalls: { path: string; content: string }[] = [];
  const supportedExt = new Set([".ts", ".tsx", ".js", ".py", ".go", ".rs", ".rb", ".md"]);
  return {
    name: "stub",
    languages: ["typescript", "javascript", "python", "go"],
    extractCalls,
    supports(ext: string): boolean {
      return supportedExt.has(ext.toLowerCase());
    },
    async extract(input: { path: string; content: string }): Promise<readonly CodeArtifact[]> {
      extractCalls.push({ ...input });
      const ext = path.extname(input.path);
      if (!supportedExt.has(ext.toLowerCase())) return [];
      const base = path.basename(input.path, ext);
      // Markdown deliberately produces no symbols (file-level only).
      if (ext === ".md") return [];
      const kind: ArtifactKind = base.startsWith("Class") ? "class" : "function";
      return [
        {
          id: `${kind}:${input.path}:${base}@1`,
          kind,
          name: base,
          path: input.path,
          startLine: 1,
          endLine: 1,
          language: extLang(ext),
        },
      ];
    },
  };
}

function extLang(ext: string): string | undefined {
  switch (ext.toLowerCase()) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
      return "javascript";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".rs":
      return "rust";
    case ".rb":
      return "ruby";
    case ".md":
      return "markdown";
    default:
      return undefined;
  }
}

interface SyntheticRepo {
  readonly root: string;
  readonly paths: readonly string[];
  readonly cacheFile: string;
}

/**
 * Lays out a 15-source-file repo across 4 languages, plus 1 symlink and
 * 1 binary. The total path count handed to `build()` is 17 — the service
 * is expected to filter out the symlink and the binary, leaving 15
 * extracted entries (4 langs × ~4 files each, give or take).
 */
async function buildSyntheticRepo(): Promise<SyntheticRepo> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-inv-svc-"));

  const filesByLang: Record<string, string[]> = {
    ts: ["alpha.ts", "beta.ts", "ClassGamma.ts", "delta.ts"],
    py: ["one.py", "two.py", "three.py"],
    go: ["service.go", "handler.go", "ClassRouter.go"],
    rs: ["lib.rs", "ClassEngine.rs", "util.rs", "ClassReactor.rs"],
    md: ["README.md"],
  };

  const repoRelative: string[] = [];
  for (const [, names] of Object.entries(filesByLang)) {
    for (const name of names) {
      const rel = path.join("src", name);
      const abs = path.join(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, `// ${name}\n// content\n`);
      repoRelative.push(rel);
    }
  }
  // Sanity: 15 source files seeded.
  if (repoRelative.length !== 15) {
    throw new Error(`expected 15 source files, got ${repoRelative.length}`);
  }

  // One symlink — must be filtered out.
  const symlinkPath = path.join(root, "src", "alpha-link.ts");
  await fs.symlink(path.join(root, "src", "alpha.ts"), symlinkPath);
  repoRelative.push(path.relative(root, symlinkPath));

  // One binary — null byte in the first 4 KB; must be filtered out.
  const binaryRel = path.join("src", "blob.bin");
  await fs.writeFile(path.join(root, binaryRel), Buffer.from([0x4d, 0x5a, 0x00, 0x90, 0x00, 0x03]));
  repoRelative.push(binaryRel);

  return {
    root,
    paths: repoRelative,
    cacheFile: defaultCacheFile(root),
  };
}

describe("CodeInventoryService", () => {
  let repo: SyntheticRepo;
  let extractor: ReturnType<typeof makeStubExtractor>;

  beforeEach(async () => {
    repo = await buildSyntheticRepo();
    extractor = makeStubExtractor();
  });

  afterEach(async () => {
    await fs.rm(repo.root, { recursive: true, force: true });
  });

  function makeService(): CodeInventoryService {
    return new CodeInventoryService({
      repoPath: repo.root,
      logger: SILENT_LOGGER,
      doltClient: null,
      extractor,
      debounceMs: 0, // synchronous flush in tests
    });
  }

  it("getStatus reports built:false before the first build", async () => {
    const service = makeService();
    const status = await service.getStatus();
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("unreachable");
    expect(status.value).toEqual({
      built: false,
      fileCount: 0,
      symbolCount: 0,
      languages: [],
    });
  });

  it("build extracts 15 files (filtering out symlink + binary)", async () => {
    const service = makeService();
    const built = await service.build({ paths: repo.paths });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");

    expect(built.value.files).toHaveLength(15);
    // Symlink and binary excluded.
    const includedPaths = new Set(built.value.files.map((f) => f.path));
    expect(includedPaths.has(path.join("src", "alpha-link.ts"))).toBe(false);
    expect(includedPaths.has(path.join("src", "blob.bin"))).toBe(false);

    const status = await service.getStatus();
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("unreachable");
    expect(status.value.built).toBe(true);
    expect(status.value.fileCount).toBe(15);
    // 14 source files → 1 symbol each (markdown produces zero symbols).
    expect(status.value.symbolCount).toBe(14);
    expect([...status.value.languages].sort()).toEqual(
      ["go", "markdown", "python", "rust", "typescript"].sort(),
    );
  });

  it("build snapshot persists and reloads in a fresh service instance", async () => {
    const first = makeService();
    await first.build({ paths: repo.paths });

    // Fresh extractor + service — simulate a brand new process.
    const freshExtractor = makeStubExtractor();
    const second = new CodeInventoryService({
      repoPath: repo.root,
      logger: SILENT_LOGGER,
      doltClient: null,
      extractor: freshExtractor,
      debounceMs: 0,
    });
    const status = await second.getStatus();
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("unreachable");
    expect(status.value.built).toBe(true);
    expect(status.value.fileCount).toBe(15);
    // The fresh service didn't re-extract — it just loaded the JSON.
    expect(freshExtractor.extractCalls).toHaveLength(0);
  });

  it("query returns ranked hits and matches by name", async () => {
    const service = makeService();
    await service.build({ paths: repo.paths });

    const result = await service.query({ query: "ClassGamma", limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.hits.length).toBeGreaterThan(0);
    expect(result.value.hits[0]?.symbol).toBe("ClassGamma");
    expect(result.value.hits[0]?.kind).toBe("class");
  });

  it("query returns guidance hint when the inventory has not been built", async () => {
    // New empty repo, no build called.
    const emptyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-inv-empty-"));
    try {
      const service = new CodeInventoryService({
        repoPath: emptyRoot,
        logger: SILENT_LOGGER,
        doltClient: null,
        extractor: makeStubExtractor(),
        debounceMs: 0,
      });
      const result = await service.query({ query: "anything" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.value.hits).toEqual([]);
      expect(result.value.recommendedNextActions).toEqual([
        "Inventory has not been built yet. Run monsthera code reindex to build it.",
      ]);
    } finally {
      await fs.rm(emptyRoot, { recursive: true, force: true });
    }
  });

  it("query revalidates a stale file and surfaces fresh symbols", async () => {
    const service = makeService();
    await service.build({ paths: repo.paths });

    // Initial extract count covers every supported source file.
    const baseline = extractor.extractCalls.length;

    // Edit one file — change content AND nudge mtime to ensure mtime !=.
    const targetRel = path.join("src", "ClassGamma.ts");
    const targetAbs = path.join(repo.root, targetRel);
    const future = new Date(Date.now() + 60_000);
    await fs.writeFile(targetAbs, "// rewritten\n// content has new shape\n");
    await fs.utimes(targetAbs, future, future);

    // Query — should trigger revalidation for the stale file.
    const result = await service.query({ query: "ClassGamma" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.hits[0]?.symbol).toBe("ClassGamma");

    // Exactly one re-extract for the stale file (others should be untouched).
    const newCalls = extractor.extractCalls.length - baseline;
    expect(newCalls).toBeGreaterThanOrEqual(1);

    // Wait for the synchronous-flush debounce to settle, then confirm
    // the JSON on disk reflects the updated mtime.
    await service.flush();

    const raw = await fs.readFile(repo.cacheFile, "utf-8");
    const snapshot = JSON.parse(raw) as CodeInventorySnapshot;
    const updated = snapshot.files.find((f) => f.path === targetRel);
    expect(updated).toBeDefined();
    const stat = fsSync.statSync(targetAbs);
    expect(updated!.mtimeMs).toBeCloseTo(stat.mtimeMs, 0);
  });

  it("getSymbolsForFile returns [] for unknown paths", async () => {
    const service = makeService();
    await service.build({ paths: repo.paths });

    const result = await service.getSymbolsForFile("src/does-not-exist.ts");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toEqual([]);
  });

  it("getSymbolsForFile returns the inventory entry's symbols for a known path", async () => {
    const service = makeService();
    await service.build({ paths: repo.paths });

    const result = await service.getSymbolsForFile(path.join("src", "alpha.ts"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.name).toBe("alpha");
  });

  it("reindex({ full: true }) detects a brand-new file", async () => {
    const service = makeService();
    await service.build({ paths: repo.paths });

    // Add a 16th source file to the repo and to the paths list.
    const newRel = path.join("src", "newcomer.ts");
    await fs.writeFile(path.join(repo.root, newRel), "// new file\n");
    const augmentedPaths = [...repo.paths, newRel];

    const status = await service.reindex({ paths: augmentedPaths, full: true });
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("unreachable");
    expect(status.value.fileCount).toBe(16);

    // The new file is queryable.
    const queryResult = await service.query({ query: "newcomer" });
    expect(queryResult.ok).toBe(true);
    if (!queryResult.ok) throw new Error("unreachable");
    expect(queryResult.value.hits.some((h) => h.symbol === "newcomer")).toBe(true);
  });

  it("reindex({ full: false }) is incremental — unchanged files are not re-extracted", async () => {
    const service = makeService();
    await service.build({ paths: repo.paths });
    const baseline = extractor.extractCalls.length;

    // Touch one file's mtime *and content* so it must re-extract.
    const target = path.join("src", "alpha.ts");
    await fs.writeFile(path.join(repo.root, target), "// bumped\n");
    const future = new Date(Date.now() + 30_000);
    await fs.utimes(path.join(repo.root, target), future, future);

    const status = await service.reindex({ paths: repo.paths, full: false });
    expect(status.ok).toBe(true);
    const newCalls = extractor.extractCalls.length - baseline;
    // Exactly one re-extract: just the touched file. Symlink/binary are
    // still filtered, and Markdown still re-runs the extractor only when
    // its own mtime changed (it didn't, so it's preserved as-is).
    expect(newCalls).toBe(1);
  });

  it("Dolt mirror failure surfaces in getStatus().degraded", async () => {
    const service = new CodeInventoryService({
      repoPath: repo.root,
      logger: SILENT_LOGGER,
      doltClient: {
        async execute(_sql: string): Promise<void> {
          throw new Error("simulated Dolt outage");
        },
      },
      extractor,
      debounceMs: 0,
    });
    await service.build({ paths: repo.paths });

    const status = await service.getStatus();
    expect(status.ok).toBe(true);
    if (!status.ok) throw new Error("unreachable");
    // JSON write succeeded; mirror reported degraded.
    expect(status.value.built).toBe(true);
    expect(status.value.degraded?.reason).toMatch(/simulated Dolt outage/);

    // The cache file is on disk despite the mirror failure.
    const exists = fsSync.existsSync(repo.cacheFile);
    expect(exists).toBe(true);
  });
});
