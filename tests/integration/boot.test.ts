import { describe, it, expect } from "vitest";
import { createContainer, createTestContainer } from "../../src/core/container.js";
import { defaultConfig } from "../../src/core/config.js";
import { VERSION } from "../../src/core/constants.js";

describe("Integration: Container boot", () => {
  it("container boots with default config", async () => {
    const config = defaultConfig("/tmp/monsthera-test");
    const container = await createContainer(config);

    expect(container).toBeDefined();
    expect(container.config).toBe(config);
    expect(container.logger).toBeDefined();
    expect(container.status).toBeDefined();

    await container.dispose();
  });

  it("status reporter returns correct version", async () => {
    const config = defaultConfig("/tmp/monsthera-test");
    const container = await createContainer(config);

    const status = container.status.getStatus();
    expect(status.version).toBe(VERSION);
    expect(typeof status.uptime).toBe("number");
    expect(status.uptime).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(status.subsystems)).toBe(true);

    await container.dispose();
  });

  it("container disposes cleanly", async () => {
    const config = defaultConfig("/tmp/monsthera-test");
    const container = await createContainer(config);

    await expect(container.dispose()).resolves.toBeUndefined();
  });

  it("status includes storage subsystem after boot", async () => {
    const config = defaultConfig("/tmp/monsthera-test");
    const container = await createContainer(config);

    const status = container.status.getStatus();
    const storage = status.subsystems.find((s) => s.name === "storage");
    expect(storage).toBeDefined();
    expect(storage?.healthy).toBe(true);

    await container.dispose();
  });

  it("createTestContainer boots and disposes cleanly", async () => {
    const container = await createTestContainer();
    expect(container.config.repoPath).toMatch(/^\/tmp\/monsthera-test-/);

    const status = container.status.getStatus();
    expect(status.version).toBe(VERSION);

    await expect(container.dispose()).resolves.toBeUndefined();
  });
});
