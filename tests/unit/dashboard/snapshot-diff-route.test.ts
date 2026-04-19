import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDashboard } from "../../../src/dashboard/index.js";
import type { DashboardServer } from "../../../src/dashboard/index.js";
import { createTestContainer } from "../../../src/core/container.js";
import type { MonstheraContainer } from "../../../src/core/container.js";
import type { EnvironmentSnapshot, SnapshotDiff } from "../../../src/context/snapshot-schema.js";

describe("GET /api/work/:id/snapshot-diff", () => {
  let container: MonstheraContainer;
  let dashboard: DashboardServer | undefined;
  let boot: NodeJS.ErrnoException | undefined;

  beforeAll(async () => {
    try {
      container = await createTestContainer();
      dashboard = await startDashboard(container, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        boot = error as NodeJS.ErrnoException;
        return;
      }
      throw error;
    }
  });

  afterAll(async () => {
    if (dashboard) await dashboard.close();
    if (container) await container.dispose();
  });

  function url(p: string): string {
    if (boot || !dashboard) return "http://127.0.0.1/unavailable";
    return `http://localhost:${dashboard.port}${p}`;
  }

  async function record(workId: string, overrides?: Partial<Parameters<typeof container.snapshotService.record>[0]>): Promise<EnvironmentSnapshot> {
    const result = await container.snapshotService.record({
      agentId: "agent-1",
      workId,
      cwd: "/app",
      files: [],
      runtimes: {},
      packageManagers: [],
      lockfiles: [],
      ...(overrides ?? {}),
    });
    if (!result.ok) throw new Error("record failed");
    return result.value;
  }

  it("404s when no snapshot has been recorded for the work id", async () => {
    if (boot) return;
    const res = await fetch(url("/api/work/w-missing/snapshot-diff"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("returns current + null baseline + null diff when only one snapshot exists", async () => {
    if (boot) return;
    await record("w-single");
    const res = await fetch(url("/api/work/w-single/snapshot-diff"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: EnvironmentSnapshot;
      baseline: EnvironmentSnapshot | null;
      diff: SnapshotDiff | null;
    };
    expect(body.current.workId).toBe("w-single");
    expect(body.baseline).toBeNull();
    expect(body.diff).toBeNull();
  });

  it("returns current + baseline + diff when two snapshots exist", async () => {
    if (boot) return;
    await record("w-diff", {
      runtimes: { node: "20.0.0" },
      lockfiles: [{ path: "pnpm-lock.yaml", sha256: "a" }],
    });
    await new Promise((r) => setTimeout(r, 5));
    await record("w-diff", {
      runtimes: { node: "22.0.0" },
      lockfiles: [{ path: "pnpm-lock.yaml", sha256: "b" }],
    });
    const res = await fetch(url("/api/work/w-diff/snapshot-diff"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      current: EnvironmentSnapshot;
      baseline: EnvironmentSnapshot;
      diff: SnapshotDiff;
    };
    expect(body.baseline).not.toBeNull();
    expect(body.diff.runtimesChanged).toContain("node");
    expect(body.diff.lockfilesChanged).toContain("pnpm-lock.yaml");
  });

  it("honours the `against` query parameter", async () => {
    if (boot) return;
    const first = await record("w-against");
    await new Promise((r) => setTimeout(r, 5));
    const second = await record("w-against");
    await new Promise((r) => setTimeout(r, 5));
    await record("w-against");
    const res = await fetch(url(`/api/work/w-against/snapshot-diff?against=${encodeURIComponent(second.id)}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { baseline: EnvironmentSnapshot | null };
    expect(body.baseline?.id).toBe(second.id);
    expect(body.baseline?.id).not.toBe(first.id);
  });

  it("404s when `against` is a missing id", async () => {
    if (boot) return;
    await record("w-badagainst");
    const res = await fetch(url("/api/work/w-badagainst/snapshot-diff?against=s-does-not-exist"));
    expect(res.status).toBe(404);
  });

  it("405s on POST with valid auth (GET-only route)", async () => {
    if (boot || !dashboard) return;
    const res = await fetch(url("/api/work/anything/snapshot-diff"), {
      method: "POST",
      headers: { Authorization: `Bearer ${dashboard.authToken}` },
    });
    expect(res.status).toBe(405);
  });
});
