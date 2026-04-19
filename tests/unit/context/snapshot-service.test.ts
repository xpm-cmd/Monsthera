import { describe, it, expect } from "vitest";
import { SnapshotService } from "../../../src/context/snapshot-service.js";
import { InMemorySnapshotRepository } from "../../../src/context/snapshot-in-memory-repository.js";
import type { Logger } from "../../../src/core/logger.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

function createService(opts?: { maxAgeMinutes?: number; now?: () => number }) {
  const repo = new InMemorySnapshotRepository();
  const service = new SnapshotService({
    repo,
    logger: noopLogger,
    maxAgeMinutes: opts?.maxAgeMinutes ?? 30,
    now: opts?.now,
  });
  return { service, repo };
}

const baseInput = {
  agentId: "agent-1",
  cwd: "/home/user/project",
  files: ["README.md"],
  runtimes: { node: "20.11.0" },
  packageManagers: ["pnpm"],
  lockfiles: [{ path: "pnpm-lock.yaml", sha256: "hash-one" }],
};

describe("SnapshotService.record", () => {
  it("assigns an s-prefixed id and capturedAt", async () => {
    const { service } = createService();
    const result = await service.record(baseInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toMatch(/^s-[a-z0-9]+$/);
    expect(new Date(result.value.capturedAt).toString()).not.toBe("Invalid Date");
  });

  it("rejects invalid input with VALIDATION_FAILED", async () => {
    const { service } = createService();
    const result = await service.record({ cwd: "/tmp" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("SnapshotService.getLatest", () => {
  it("returns null when no snapshot matches", async () => {
    const { service } = createService();
    const result = await service.getLatest({ agentId: "nobody" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it("returns the most recent snapshot by agentId", async () => {
    const { service } = createService();
    const first = await service.record(baseInput);
    expect(first.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    const second = await service.record({ ...baseInput, cwd: "/home/user/other" });
    expect(second.ok).toBe(true);
    const latest = await service.getLatest({ agentId: "agent-1" });
    expect(latest.ok).toBe(true);
    if (!latest.ok || !latest.value) throw new Error("expected a snapshot");
    expect(latest.value.snapshot.cwd).toBe("/home/user/other");
  });

  it("prefers the work-scoped snapshot when workId is provided", async () => {
    const { service } = createService();
    await service.record({ ...baseInput, workId: "w-one", cwd: "/w-one" });
    await new Promise((r) => setTimeout(r, 5));
    await service.record({ ...baseInput, workId: "w-two", cwd: "/w-two" });
    const latest = await service.getLatest({ workId: "w-one" });
    expect(latest.ok).toBe(true);
    if (!latest.ok || !latest.value) throw new Error("expected a snapshot");
    expect(latest.value.snapshot.cwd).toBe("/w-one");
  });

  it("falls back to the agent's latest when the workId has no snapshot", async () => {
    const { service } = createService();
    const recent = await service.record({ ...baseInput, cwd: "/fallback" });
    expect(recent.ok).toBe(true);
    const latest = await service.getLatest({ workId: "w-unknown", agentId: "agent-1" });
    expect(latest.ok).toBe(true);
    if (!latest.ok || !latest.value) throw new Error("expected a snapshot");
    expect(latest.value.snapshot.cwd).toBe("/fallback");
  });

  it("rejects lookups with neither agentId nor workId", async () => {
    const { service } = createService();
    const result = await service.getLatest({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION_FAILED");
  });

  it("computes ageSeconds and flags stale snapshots when older than maxAgeMinutes", async () => {
    const fixedNow = Date.UTC(2026, 3, 19, 12, 0, 0);
    const past = new Date(fixedNow - 60 * 60 * 1000).toISOString(); // 1h earlier
    const { service, repo } = createService({ maxAgeMinutes: 30, now: () => fixedNow });
    // Bypass validation to insert a snapshot with a known past capturedAt.
    const recorded = await repo.record(baseInput);
    if (!recorded.ok) throw new Error("seed failed");
    // Mutate the stored capturedAt so the age calculation has a known value.
    (recorded.value as { capturedAt: string }).capturedAt = past;
    const result = await service.getLatest({ agentId: "agent-1" });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value) throw new Error("expected a snapshot");
    expect(result.value.ageSeconds).toBe(3600);
    expect(result.value.stale).toBe(true);
  });

  it("treats maxAgeMinutes=0 as disabling the stale check", async () => {
    const fixedNow = Date.UTC(2026, 3, 19, 12, 0, 0);
    const past = new Date(fixedNow - 48 * 60 * 60 * 1000).toISOString();
    const { service, repo } = createService({ maxAgeMinutes: 0, now: () => fixedNow });
    const recorded = await repo.record(baseInput);
    if (!recorded.ok) throw new Error("seed failed");
    (recorded.value as { capturedAt: string }).capturedAt = past;
    const result = await service.getLatest({ agentId: "agent-1" });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value) throw new Error("expected a snapshot");
    expect(result.value.stale).toBe(false);
  });
});

describe("SnapshotService.compare", () => {
  it("flags changed runtimes, lockfiles, branch, and cwd", async () => {
    const { service } = createService();
    const left = await service.record({
      ...baseInput,
      gitRef: { branch: "main", sha: "aaa" },
    });
    const right = await service.record({
      ...baseInput,
      cwd: "/home/user/other",
      runtimes: { node: "22.0.0" },
      lockfiles: [{ path: "pnpm-lock.yaml", sha256: "hash-two" }],
      gitRef: { branch: "feature", sha: "aaa" },
    });
    expect(left.ok && right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    const diff = await service.compare(left.value.id, right.value.id);
    expect(diff.ok).toBe(true);
    if (!diff.ok) return;
    expect(diff.value.cwdChanged).toBe(true);
    expect(diff.value.branchChanged).toBe(true);
    expect(diff.value.shaChanged).toBe(false);
    expect(diff.value.runtimesChanged).toEqual(["node"]);
    expect(diff.value.lockfilesChanged).toEqual(["pnpm-lock.yaml"]);
  });

  it("returns a NotFoundError when either id is unknown", async () => {
    const { service } = createService();
    const seeded = await service.record(baseInput);
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const result = await service.compare(seeded.value.id, "s-missing");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });
});
