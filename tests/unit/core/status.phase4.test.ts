/**
 * M3 phase 4 — `monsthera status` codeInventory round-trip (ADR-017 §D9).
 *
 * Lives alongside the existing `status.test.ts` regression suite. The
 * sync `getStatus()` continues to return the snapshot stats only;
 * `getStatusAsync()` resolves registered providers and merges them into
 * `stats`, which is where the `codeInventory` block lands.
 */

import { describe, it, expect } from "vitest";
import { createStatusReporter } from "../../../src/core/status.js";

describe("createStatusReporter() — phase 4 codeInventory provider", () => {
  it("sync getStatus() does NOT include async-provider stats", () => {
    const reporter = createStatusReporter("3.0.0");
    reporter.registerStatProvider("codeInventory", async () => ({
      built: true,
      fileCount: 7,
      symbolCount: 42,
      languages: ["typescript", "python"],
    }));

    const status = reporter.getStatus();
    // No call to getStatusAsync, so the provider has not been resolved.
    expect(status.stats?.codeInventory).toBeUndefined();
  });

  it("getStatusAsync() resolves the codeInventory provider into stats", async () => {
    const reporter = createStatusReporter("3.0.0");
    reporter.registerStatProvider("codeInventory", async () => ({
      built: true,
      fileCount: 7,
      symbolCount: 42,
      languages: ["typescript", "python"],
      lastReindexAt: "2026-05-03T12:00:00Z",
      staleFileCount: 0,
    }));

    const status = await reporter.getStatusAsync();
    expect(status.stats?.codeInventory).toEqual({
      built: true,
      fileCount: 7,
      symbolCount: 42,
      languages: ["typescript", "python"],
      lastReindexAt: "2026-05-03T12:00:00Z",
      staleFileCount: 0,
    });
  });

  it("a provider that throws is silently skipped — status reads must not fail", async () => {
    const reporter = createStatusReporter("3.0.0");
    reporter.registerStatProvider("codeInventory", async () => {
      throw new Error("persistence offline");
    });
    reporter.registerStatProvider("other", async () => ({ ok: true }));

    const status = await reporter.getStatusAsync();
    expect(status.stats?.codeInventory).toBeUndefined();
    expect((status.stats as Record<string, unknown> | undefined)?.other).toEqual({ ok: true });
  });

  it("a provider that resolves to undefined omits the key entirely", async () => {
    const reporter = createStatusReporter("3.0.0");
    reporter.registerStatProvider("codeInventory", async () => undefined);
    reporter.recordStat("knowledgeArticleCount", 5);

    const status = await reporter.getStatusAsync();
    expect(status.stats?.codeInventory).toBeUndefined();
    expect(status.stats?.knowledgeArticleCount).toBe(5);
  });

  it("getStatusAsync() merges provider results with recordStat() snapshots", async () => {
    const reporter = createStatusReporter("3.0.0");
    reporter.recordStat("knowledgeArticleCount", 10);
    reporter.recordStat("workArticleCount", 4);
    reporter.registerStatProvider("codeInventory", async () => ({
      built: false,
      fileCount: 0,
      symbolCount: 0,
      languages: [],
    }));

    const status = await reporter.getStatusAsync();
    expect(status.stats?.knowledgeArticleCount).toBe(10);
    expect(status.stats?.workArticleCount).toBe(4);
    expect(status.stats?.codeInventory).toEqual({
      built: false,
      fileCount: 0,
      symbolCount: 0,
      languages: [],
    });
  });

  it("re-registering a provider replaces the previous one", async () => {
    const reporter = createStatusReporter("3.0.0");
    reporter.registerStatProvider("codeInventory", async () => ({
      built: false,
      fileCount: 0,
      symbolCount: 0,
      languages: [],
    }));
    reporter.registerStatProvider("codeInventory", async () => ({
      built: true,
      fileCount: 3,
      symbolCount: 12,
      languages: ["go"],
    }));

    const status = await reporter.getStatusAsync();
    expect(status.stats?.codeInventory).toEqual({
      built: true,
      fileCount: 3,
      symbolCount: 12,
      languages: ["go"],
    });
  });

  it("the provider runs once per getStatusAsync() call (snapshot freshness)", async () => {
    const reporter = createStatusReporter("3.0.0");
    let invocations = 0;
    reporter.registerStatProvider("codeInventory", async () => {
      invocations += 1;
      return {
        built: true,
        fileCount: invocations,
        symbolCount: 0,
        languages: [],
      };
    });

    const first = await reporter.getStatusAsync();
    const second = await reporter.getStatusAsync();
    expect(invocations).toBe(2);
    const firstInventory = first.stats?.codeInventory;
    const secondInventory = second.stats?.codeInventory;
    expect(firstInventory?.fileCount).toBe(1);
    expect(secondInventory?.fileCount).toBe(2);
  });
});
