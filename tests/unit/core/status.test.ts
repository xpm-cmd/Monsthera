import { describe, it, expect } from "vitest";
import { createStatusReporter } from "../../../src/core/status.js";

describe("createStatusReporter()", () => {
  it("creates a status reporter with the given version", () => {
    const reporter = createStatusReporter("1.2.3");
    const status = reporter.getStatus();
    expect(status.version).toBe("1.2.3");
  });

  it("empty reporter returns zero subsystems", () => {
    const reporter = createStatusReporter("0.0.1");
    const status = reporter.getStatus();
    expect(status.subsystems).toHaveLength(0);
    expect(Array.isArray(status.subsystems)).toBe(true);
  });

  it("registered subsystem appears in status", () => {
    const reporter = createStatusReporter("1.0.0");
    reporter.register("database", () => ({ name: "database", healthy: true }));
    const status = reporter.getStatus();
    expect(status.subsystems).toHaveLength(1);
    expect(status.subsystems[0]!.name).toBe("database");
    expect(status.subsystems[0]!.healthy).toBe(true);
  });

  it("multiple subsystems are all reported", () => {
    const reporter = createStatusReporter("1.0.0");
    reporter.register("db", () => ({ name: "db", healthy: true }));
    reporter.register("cache", () => ({ name: "cache", healthy: false, detail: "connection refused" }));
    reporter.register("search", () => ({ name: "search", healthy: true }));
    const status = reporter.getStatus();
    expect(status.subsystems).toHaveLength(3);
    const names = status.subsystems.map((s) => s.name);
    expect(names).toContain("db");
    expect(names).toContain("cache");
    expect(names).toContain("search");
    const cache = status.subsystems.find((s) => s.name === "cache");
    expect(cache).toBeDefined();
    expect(cache!.healthy).toBe(false);
    expect(cache!.detail).toBe("connection refused");
  });

  it("unregistering a subsystem removes it from status", () => {
    const reporter = createStatusReporter("1.0.0");
    reporter.register("db", () => ({ name: "db", healthy: true }));
    reporter.register("cache", () => ({ name: "cache", healthy: true }));
    reporter.unregister("db");
    const status = reporter.getStatus();
    expect(status.subsystems).toHaveLength(1);
    expect(status.subsystems[0]!.name).toBe("cache");
  });

  it("uptime is at least 0 and increases over time", async () => {
    const reporter = createStatusReporter("1.0.0");
    const first = reporter.getStatus();
    expect(first.uptime).toBeGreaterThanOrEqual(0);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = reporter.getStatus();
    expect(second.uptime).toBeGreaterThan(first.uptime);
  });

  it("timestamp is a valid ISO 8601 string", () => {
    const reporter = createStatusReporter("1.0.0");
    const status = reporter.getStatus();
    expect(typeof status.timestamp).toBe("string");
    expect(status.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    const parsed = new Date(status.timestamp);
    expect(isNaN(parsed.getTime())).toBe(false);
  });

  it("health check function is called on each getStatus() invocation", () => {
    const reporter = createStatusReporter("1.0.0");
    let callCount = 0;
    reporter.register("counter", () => {
      callCount++;
      return { name: "counter", healthy: true };
    });
    reporter.getStatus();
    reporter.getStatus();
    reporter.getStatus();
    expect(callCount).toBe(3);
  });
});
