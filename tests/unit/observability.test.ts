import { describe, it, expect, afterEach } from "vitest";
import { startDashboard } from "../../src/dashboard/index.js";
import type { DashboardServer } from "../../src/dashboard/index.js";
import { createTestContainer } from "../../src/core/container.js";
import type { MonstheraContainer } from "../../src/core/container.js";
import { createStatusReporter } from "../../src/core/status.js";
import { VERSION } from "../../src/core/constants.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

let servers: DashboardServer[] = [];

afterEach(async () => {
  for (const s of servers) {
    await s.close();
  }
  servers = [];
});

async function startTestDashboard(container: MonstheraContainer): Promise<DashboardServer> {
  const dashboard = await startDashboard(container, 0);
  servers.push(dashboard);
  return dashboard;
}

// ─── Dashboard /api/health endpoint ─────────────────────────────────────────

describe("Dashboard /api/health endpoint", () => {
  it("returns 200 with healthy: true when all subsystems are healthy", async () => {
    const container = await createTestContainer();
    container.status.register("db", () => ({ name: "db", healthy: true }));
    const dashboard = await startTestDashboard(container);

    const res = await fetch(`http://localhost:${dashboard.port}/api/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { healthy: boolean };
    expect(body.healthy).toBe(true);
  });

  it("returns 503 with healthy: false when a subsystem is unhealthy", async () => {
    const container = await createTestContainer();
    container.status.register("db", () => ({ name: "db", healthy: true }));
    container.status.register("cache", () => ({
      name: "cache",
      healthy: false,
      detail: "connection refused",
    }));
    const dashboard = await startTestDashboard(container);

    const res = await fetch(`http://localhost:${dashboard.port}/api/health`);
    expect(res.status).toBe(503);

    const body = (await res.json()) as { healthy: boolean; subsystems: Array<{ name: string; healthy: boolean; detail?: string }> };
    expect(body.healthy).toBe(false);
    const cache = body.subsystems.find((s) => s.name === "cache");
    expect(cache).toBeDefined();
    expect(cache!.healthy).toBe(false);
    expect(cache!.detail).toBe("connection refused");
  });

  it("includes version and uptime", async () => {
    const container = await createTestContainer();
    const dashboard = await startTestDashboard(container);

    const res = await fetch(`http://localhost:${dashboard.port}/api/health`);
    const body = (await res.json()) as { version: string; uptime: number };

    expect(body).toHaveProperty("version", VERSION);
    expect(body).toHaveProperty("uptime");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("includes subsystem statuses", async () => {
    const container = await createTestContainer();
    container.status.register("storage", () => ({
      name: "storage",
      healthy: true,
      detail: "ok",
    }));
    const dashboard = await startTestDashboard(container);

    const res = await fetch(`http://localhost:${dashboard.port}/api/health`);
    const body = (await res.json()) as { subsystems: Array<{ name: string; healthy: boolean; detail?: string }> };

    expect(body).toHaveProperty("subsystems");
    expect(Array.isArray(body.subsystems)).toBe(true);
    const storage = body.subsystems.find((s) => s.name === "storage");
    expect(storage).toBeDefined();
    expect(storage!.healthy).toBe(true);
  });
});

// ─── StatusReporter recordStat ──────────────────────────────────────────────

describe("StatusReporter recordStat", () => {
  it("records and exposes stats in getStatus()", () => {
    const reporter = createStatusReporter("1.0.0-test");
    reporter.recordStat("knowledgeArticleCount", 42);
    reporter.recordStat("workArticleCount", 7);

    const status = reporter.getStatus();
    expect(status.stats).toBeDefined();
    expect(status.stats!.knowledgeArticleCount).toBe(42);
    expect(status.stats!.workArticleCount).toBe(7);
  });

  it("getStatus has no stats field when nothing recorded", () => {
    const reporter = createStatusReporter("1.0.0-test");
    const status = reporter.getStatus();
    expect(status.stats).toBeUndefined();
  });

  it("overwrites existing stat with same key", () => {
    const reporter = createStatusReporter("1.0.0-test");
    reporter.recordStat("knowledgeArticleCount", 10);
    reporter.recordStat("knowledgeArticleCount", 99);

    const status = reporter.getStatus();
    expect(status.stats!.knowledgeArticleCount).toBe(99);
  });
});
