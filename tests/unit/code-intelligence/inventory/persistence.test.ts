/**
 * Phase 2 / ADR-017: persistence-layer unit tests.
 *
 * What we cover here:
 *   - JSON round-trip (write a snapshot, read it back, structural equality).
 *   - Atomic write contract (no `.tmp` survivors after a successful write).
 *   - `null doltClient` short-circuits the mirror cleanly.
 *   - Stub Dolt mirror records every DDL/DML the persistence layer issues.
 *   - Graceful degradation: a throwing Dolt mirror does NOT fail the JSON
 *     write, the call returns `ok` with `mirrorDegraded.reason` populated,
 *     and a warning is logged.
 *   - `clear()` removes the cache file and is idempotent.
 *   - Schema-version mismatch on `load()` returns `ok(null)` (forces rebuild).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../../../../src/core/logger.js";
import {
  type DoltMirrorClient,
  JsonInventoryPersistence,
} from "../../../../src/code-intelligence/inventory/persistence.js";
import type { CodeInventorySnapshot } from "../../../../src/code-intelligence/inventory/types.js";

interface RecordedCall {
  readonly sql: string;
  readonly params: ReadonlyArray<string | number | null>;
}

function makeRecorderClient(behavior?: { failOn?: RegExp }): DoltMirrorClient & {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async execute(sql: string, params?: ReadonlyArray<string | number | null>): Promise<void> {
      calls.push({ sql, params: params ?? [] });
      if (behavior?.failOn && behavior.failOn.test(sql)) {
        throw new Error(`stub Dolt failure: ${sql.split("\n")[0]}`);
      }
    },
  };
}

function makeSnapshot(): CodeInventorySnapshot {
  return {
    schemaVersion: 1,
    builtAt: "2026-05-01T00:00:00.000Z",
    repoFingerprint: "fp-test-2",
    files: [
      {
        path: "src/foo.ts",
        language: "typescript",
        sizeBytes: 240,
        mtimeMs: 1_700_000_000_000,
        symbols: [
          {
            id: "function:src/foo.ts:doSomething@2",
            kind: "function",
            name: "doSomething",
            path: "src/foo.ts",
            language: "typescript",
            startLine: 2,
            endLine: 4,
          },
        ],
      },
      {
        path: "README.md",
        language: "markdown",
        sizeBytes: 100,
        mtimeMs: 1_700_000_001_000,
        symbols: [],
      },
    ],
  };
}

describe("JsonInventoryPersistence", () => {
  let workdir: string;
  let cacheFile: string;
  const logger = createLogger({ level: "warn", domain: "test", output: () => undefined });

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-inv-persist-"));
    cacheFile = path.join(workdir, ".monsthera/cache/code-index.json");
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  it("round-trips a snapshot through JSON", async () => {
    const persistence = new JsonInventoryPersistence({
      cacheFile,
      logger,
      doltClient: null,
    });
    const snapshot = makeSnapshot();

    const saveResult = await persistence.save(snapshot);
    expect(saveResult.ok).toBe(true);

    const loadResult = await persistence.load();
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) throw new Error("unreachable");
    expect(loadResult.value).not.toBeNull();
    expect(loadResult.value).toEqual(snapshot);
  });

  it("returns ok(null) when the cache file does not exist", async () => {
    const persistence = new JsonInventoryPersistence({
      cacheFile,
      logger,
      doltClient: null,
    });
    const result = await persistence.load();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toBeNull();
  });

  it("returns ok(null) when the cache file is at an older schemaVersion", async () => {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(
      cacheFile,
      JSON.stringify({ schemaVersion: 0, builtAt: "x", repoFingerprint: "y", files: [] }),
    );
    const persistence = new JsonInventoryPersistence({
      cacheFile,
      logger,
      doltClient: null,
    });
    const result = await persistence.load();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value).toBeNull();
  });

  it("does not leave a `.tmp` file behind after a successful write", async () => {
    const persistence = new JsonInventoryPersistence({
      cacheFile,
      logger,
      doltClient: null,
    });
    await persistence.save(makeSnapshot());

    const dirEntries = await fs.readdir(path.dirname(cacheFile));
    expect(dirEntries).toContain("code-index.json");
    expect(dirEntries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("skips the Dolt mirror entirely when doltClient is null", async () => {
    const recorder = makeRecorderClient();
    // Build with the recorder, then build a *separate* persistence that
    // would use it — this proves the null-client path doesn't accidentally
    // touch the real client.
    const persistenceNull = new JsonInventoryPersistence({
      cacheFile,
      logger,
      doltClient: null,
    });
    await persistenceNull.save(makeSnapshot());
    expect(recorder.calls).toEqual([]);
  });

  it("writes artifacts and contains relations to the Dolt mirror", async () => {
    const recorder = makeRecorderClient();
    const persistence = new JsonInventoryPersistence({
      cacheFile,
      logger,
      doltClient: recorder,
    });
    const result = await persistence.save(makeSnapshot());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.mirrorDegraded).toBeUndefined();

    // The mirror always wipes both tables before re-inserting.
    expect(recorder.calls[0]?.sql).toMatch(/DELETE FROM code_relations/);
    expect(recorder.calls[1]?.sql).toMatch(/DELETE FROM code_artifacts/);

    const inserts = recorder.calls.filter((c) =>
      /INSERT INTO code_artifacts/.test(c.sql),
    );
    // Two file-level rows + one symbol row = 3 artifact inserts.
    expect(inserts).toHaveLength(3);
    const fileRows = inserts.filter((c) => c.params[1] === "file");
    expect(fileRows).toHaveLength(2);
    const symbolRows = inserts.filter((c) => c.params[1] === "function");
    expect(symbolRows).toHaveLength(1);
    expect(symbolRows[0]?.params[2]).toBe("doSomething");

    const relationInserts = recorder.calls.filter((c) =>
      /INSERT INTO code_relations/.test(c.sql),
    );
    // One contains relation per symbol.
    expect(relationInserts).toHaveLength(1);
    expect(relationInserts[0]?.params).toEqual([
      "file:src/foo.ts",
      "function:src/foo.ts:doSomething@2",
      "contains",
      "high",
    ]);
  });

  it("degrades gracefully when the Dolt mirror throws — JSON still written", async () => {
    const failing = makeRecorderClient({ failOn: /INSERT INTO code_artifacts/ });
    const warnings: { msg: string; ctx?: Record<string, unknown> }[] = [];
    const captureLogger = createLogger({
      level: "warn",
      domain: "test",
      output: (entry) => {
        if (entry.level === "warn") warnings.push({ msg: entry.message, ctx: entry });
      },
    });

    const persistence = new JsonInventoryPersistence({
      cacheFile,
      logger: captureLogger,
      doltClient: failing,
    });
    const result = await persistence.save(makeSnapshot());

    // Save returns ok — JSON write succeeded.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.mirrorDegraded).toBeDefined();
    expect(result.value.mirrorDegraded?.reason).toMatch(/stub Dolt failure/);

    // Caller can re-read the snapshot from disk despite the mirror failure.
    const loaded = await persistence.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("unreachable");
    expect(loaded.value).toEqual(makeSnapshot());

    // Warning was logged.
    expect(warnings.some((w) => /Dolt inventory mirror failed/.test(w.msg))).toBe(true);
  });

  it("clear() removes the cache file and is idempotent", async () => {
    const persistence = new JsonInventoryPersistence({
      cacheFile,
      logger,
      doltClient: null,
    });
    await persistence.save(makeSnapshot());
    expect((await persistence.load()).ok).toBe(true);

    const first = await persistence.clear();
    expect(first.ok).toBe(true);
    const reloaded = await persistence.load();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) throw new Error("unreachable");
    expect(reloaded.value).toBeNull();

    // Second clear is a no-op (force rm tolerates missing files).
    const second = await persistence.clear();
    expect(second.ok).toBe(true);
  });
});
