import { describe, it, expect } from "vitest";
import {
  WorkPhase,
  WorkTemplate,
  Priority,
  workId,
  agentId,
  timestamp,
} from "../../../src/core/types.js";
import type { WorkArticle } from "../../../src/work/repository.js";
import { evaluateAsyncGuards, getAsyncGuardSet } from "../../../src/work/lifecycle.js";
import { InMemorySnapshotRepository } from "../../../src/context/snapshot-in-memory-repository.js";
import { SnapshotService } from "../../../src/context/snapshot-service.js";
import { createLogger } from "../../../src/core/logger.js";

const LOGGER = createLogger({ level: "warn", domain: "test" });

function makeArticle(overrides: Partial<WorkArticle> = {}): WorkArticle {
  return {
    id: workId("w-snap1234"),
    title: "Snapshot-gated feature",
    template: WorkTemplate.FEATURE,
    phase: WorkPhase.ENRICHMENT,
    priority: Priority.MEDIUM,
    author: agentId("agent-1"),
    enrichmentRoles: [],
    reviewers: [],
    phaseHistory: [{ phase: WorkPhase.ENRICHMENT, enteredAt: timestamp() }],
    tags: [],
    references: [],
    codeRefs: [],
    dependencies: [],
    blockedBy: [],
    content: "",
    createdAt: timestamp(),
    updatedAt: timestamp(),
    ...overrides,
  };
}

async function makeService(maxAgeMinutes = 30): Promise<SnapshotService> {
  const repo = new InMemorySnapshotRepository();
  return new SnapshotService({ repo, logger: LOGGER, maxAgeMinutes });
}

describe("snapshot_ready guard — async", () => {
  it("returns empty set for non-feature templates even when opted in", () => {
    const article = makeArticle({ template: WorkTemplate.BUGFIX });
    const service = new SnapshotService({
      repo: new InMemorySnapshotRepository(),
      logger: LOGGER,
      maxAgeMinutes: 30,
    });
    const set = getAsyncGuardSet(article, WorkPhase.ENRICHMENT, WorkPhase.IMPLEMENTATION, {
      snapshotService: service,
    });
    expect(set).toHaveLength(0);
  });

  it("returns empty set for feature when snapshotService is missing (backwards compat)", () => {
    const set = getAsyncGuardSet(
      makeArticle(),
      WorkPhase.ENRICHMENT,
      WorkPhase.IMPLEMENTATION,
      {},
    );
    expect(set).toHaveLength(0);
  });

  it("fails when no snapshot has been recorded for the work id", async () => {
    const service = await makeService();
    const article = makeArticle();
    const result = await evaluateAsyncGuards(
      article,
      WorkPhase.ENRICHMENT,
      WorkPhase.IMPLEMENTATION,
      {},
      { snapshotService: service },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("snapshot_ready");
    }
  });

  it("fails when the recorded snapshot is flagged stale", async () => {
    const service = await makeService(30);
    const article = makeArticle();
    // Backfill a snapshot whose capturedAt is 2h old.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const repo = (service as unknown as { repo: InMemorySnapshotRepository }).repo;
    const stored = await repo.record({
      agentId: "agent-1",
      workId: article.id,
      cwd: "/app",
      files: [],
      runtimes: {},
      packageManagers: [],
      lockfiles: [],
    });
    if (!stored.ok) throw new Error("failed to seed snapshot");
    // Monkey-patch capturedAt to make the snapshot stale.
    (stored.value as { capturedAt: string }).capturedAt = twoHoursAgo;

    const result = await evaluateAsyncGuards(
      article,
      WorkPhase.ENRICHMENT,
      WorkPhase.IMPLEMENTATION,
      {},
      { snapshotService: service },
    );
    expect(result.ok).toBe(false);
  });

  it("fails when a HEAD lockfile sha differs from the snapshot", async () => {
    const service = await makeService();
    const article = makeArticle();
    const stored = await service.record({
      agentId: "agent-1",
      workId: article.id,
      cwd: "/app",
      files: [],
      runtimes: {},
      packageManagers: [],
      lockfiles: [{ path: "pnpm-lock.yaml", sha256: "old-hash" }],
    });
    if (!stored.ok) throw new Error("failed to seed snapshot");

    const result = await evaluateAsyncGuards(
      article,
      WorkPhase.ENRICHMENT,
      WorkPhase.IMPLEMENTATION,
      {},
      {
        snapshotService: service,
        headLockfileHashes: { "pnpm-lock.yaml": "new-hash" },
      },
    );
    expect(result.ok).toBe(false);
  });

  it("fails when the snapshot is missing a HEAD lockfile entry entirely", async () => {
    const service = await makeService();
    const article = makeArticle();
    const stored = await service.record({
      agentId: "agent-1",
      workId: article.id,
      cwd: "/app",
      files: [],
      runtimes: {},
      packageManagers: [],
      lockfiles: [],
    });
    if (!stored.ok) throw new Error("failed to seed snapshot");

    const result = await evaluateAsyncGuards(
      article,
      WorkPhase.ENRICHMENT,
      WorkPhase.IMPLEMENTATION,
      {},
      {
        snapshotService: service,
        headLockfileHashes: { "pnpm-lock.yaml": "some-hash" },
      },
    );
    expect(result.ok).toBe(false);
  });

  it("passes when snapshot is fresh and lockfiles match HEAD", async () => {
    const service = await makeService();
    const article = makeArticle();
    const stored = await service.record({
      agentId: "agent-1",
      workId: article.id,
      cwd: "/app",
      files: [],
      runtimes: {},
      packageManagers: [],
      lockfiles: [{ path: "pnpm-lock.yaml", sha256: "match-me" }],
    });
    if (!stored.ok) throw new Error("failed to seed snapshot");

    const result = await evaluateAsyncGuards(
      article,
      WorkPhase.ENRICHMENT,
      WorkPhase.IMPLEMENTATION,
      {},
      {
        snapshotService: service,
        headLockfileHashes: { "pnpm-lock.yaml": "match-me" },
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skippedGuards).toEqual([]);
    }
  });

  it("passes with maxAgeMinutes=0 (freshness disabled) but still enforces lockfile match", async () => {
    const service = await makeService(0);
    const article = makeArticle();
    const stored = await service.record({
      agentId: "agent-1",
      workId: article.id,
      cwd: "/app",
      files: [],
      runtimes: {},
      packageManagers: [],
      lockfiles: [{ path: "pnpm-lock.yaml", sha256: "match-me" }],
    });
    if (!stored.ok) throw new Error("failed to seed snapshot");
    // Make it old; staleness should not gate.
    (stored.value as { capturedAt: string }).capturedAt =
      new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const okResult = await evaluateAsyncGuards(
      article,
      WorkPhase.ENRICHMENT,
      WorkPhase.IMPLEMENTATION,
      {},
      {
        snapshotService: service,
        headLockfileHashes: { "pnpm-lock.yaml": "match-me" },
      },
    );
    expect(okResult.ok).toBe(true);

    const mismatch = await evaluateAsyncGuards(
      article,
      WorkPhase.ENRICHMENT,
      WorkPhase.IMPLEMENTATION,
      {},
      {
        snapshotService: service,
        headLockfileHashes: { "pnpm-lock.yaml": "different" },
      },
    );
    expect(mismatch.ok).toBe(false);
  });

  it("bypasses a failing guard with skipGuard and records the name", async () => {
    const service = await makeService();
    const article = makeArticle();
    const result = await evaluateAsyncGuards(
      article,
      WorkPhase.ENRICHMENT,
      WorkPhase.IMPLEMENTATION,
      { skipGuard: { reason: "bench-only run" } },
      { snapshotService: service },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skippedGuards).toEqual(["snapshot_ready"]);
    }
  });
});
