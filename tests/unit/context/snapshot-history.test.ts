import { describe, it, expect } from "vitest";
import { InMemorySnapshotRepository } from "../../../src/context/snapshot-in-memory-repository.js";
import { SnapshotService } from "../../../src/context/snapshot-service.js";
import { createLogger } from "../../../src/core/logger.js";

const LOGGER = createLogger({ level: "warn", domain: "test" });

describe("InMemorySnapshotRepository.findAllByWork", () => {
  it("returns an empty array when no snapshots match the work id", async () => {
    const repo = new InMemorySnapshotRepository();
    const result = await repo.findAllByWork("w-missing");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it("returns only snapshots matching the given work id, oldest first", async () => {
    const repo = new InMemorySnapshotRepository();
    await repo.record({ agentId: "a", workId: "w-1", cwd: "/", files: [], runtimes: {}, packageManagers: [], lockfiles: [] });
    await new Promise((r) => setTimeout(r, 5));
    await repo.record({ agentId: "a", workId: "w-other", cwd: "/", files: [], runtimes: {}, packageManagers: [], lockfiles: [] });
    await new Promise((r) => setTimeout(r, 5));
    await repo.record({ agentId: "a", workId: "w-1", cwd: "/", files: [], runtimes: {}, packageManagers: [], lockfiles: [] });
    await new Promise((r) => setTimeout(r, 5));
    await repo.record({ agentId: "a", workId: "w-1", cwd: "/", files: [], runtimes: {}, packageManagers: [], lockfiles: [] });

    const result = await repo.findAllByWork("w-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
    for (let i = 1; i < result.value.length; i += 1) {
      expect(
        result.value[i]!.capturedAt >= result.value[i - 1]!.capturedAt,
      ).toBe(true);
    }
  });
});

describe("SnapshotService.getDiffForWork", () => {
  async function makeService(): Promise<SnapshotService> {
    return new SnapshotService({
      repo: new InMemorySnapshotRepository(),
      logger: LOGGER,
      maxAgeMinutes: 30,
    });
  }

  it("returns null when no snapshot exists for the work id", async () => {
    const service = await makeService();
    const result = await service.getDiffForWork("w-nope");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeNull();
  });

  it("returns current + null baseline + null diff when only one snapshot exists", async () => {
    const service = await makeService();
    await service.record({ agentId: "a", workId: "w-1", cwd: "/", files: [], runtimes: {}, packageManagers: [], lockfiles: [] });
    const result = await service.getDiffForWork("w-1");
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value) throw new Error("expected value");
    expect(result.value.baseline).toBeNull();
    expect(result.value.diff).toBeNull();
    expect(result.value.current.workId).toBe("w-1");
  });

  it("uses the oldest snapshot as baseline and diffs against the latest", async () => {
    const service = await makeService();
    const first = await service.record({
      agentId: "a",
      workId: "w-1",
      cwd: "/app",
      files: [],
      runtimes: { node: "20.0.0" },
      packageManagers: ["pnpm"],
      lockfiles: [{ path: "pnpm-lock.yaml", sha256: "old-sha" }],
    });
    await new Promise((r) => setTimeout(r, 5));
    const latest = await service.record({
      agentId: "a",
      workId: "w-1",
      cwd: "/other",
      files: [],
      runtimes: { node: "22.0.0" },
      packageManagers: ["pnpm"],
      lockfiles: [{ path: "pnpm-lock.yaml", sha256: "new-sha" }],
    });
    if (!first.ok || !latest.ok) throw new Error("seed failed");

    const result = await service.getDiffForWork("w-1");
    if (!result.ok || !result.value || !result.value.baseline || !result.value.diff) {
      throw new Error("expected full diff");
    }
    expect(result.value.baseline.id).toBe(first.value.id);
    expect(result.value.current.id).toBe(latest.value.id);
    expect(result.value.diff.runtimesChanged).toContain("node");
    expect(result.value.diff.lockfilesChanged).toContain("pnpm-lock.yaml");
    expect(result.value.diff.cwdChanged).toBe(true);
  });

  it("honours an explicit baselineId via the `against` parameter", async () => {
    const service = await makeService();
    const first = await service.record({ agentId: "a", workId: "w-1", cwd: "/app", files: [], runtimes: {}, packageManagers: [], lockfiles: [] });
    await new Promise((r) => setTimeout(r, 5));
    const second = await service.record({ agentId: "a", workId: "w-1", cwd: "/app", files: [], runtimes: {}, packageManagers: [], lockfiles: [] });
    await new Promise((r) => setTimeout(r, 5));
    await service.record({ agentId: "a", workId: "w-1", cwd: "/app", files: [], runtimes: {}, packageManagers: [], lockfiles: [] });
    if (!first.ok || !second.ok) throw new Error("seed failed");

    const result = await service.getDiffForWork("w-1", second.value.id);
    if (!result.ok || !result.value || !result.value.baseline) throw new Error("expected baseline");
    expect(result.value.baseline.id).toBe(second.value.id);
  });

  it("returns NotFoundError when `against` id does not resolve", async () => {
    const service = await makeService();
    await service.record({ agentId: "a", workId: "w-1", cwd: "/", files: [], runtimes: {}, packageManagers: [], lockfiles: [] });
    const result = await service.getDiffForWork("w-1", "s-does-not-exist");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });
});
