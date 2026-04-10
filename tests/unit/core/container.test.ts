import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { createContainer, createTestContainer } from "../../../src/core/container.js";
import { defaultConfig } from "../../../src/core/config.js";
import { VERSION } from "../../../src/core/constants.js";

const testConfig = defaultConfig("/tmp/monsthera-test");

describe("createContainer()", () => {
  it("returns a container with all required fields", async () => {
    const container = await createContainer(testConfig);
    expect(container).toHaveProperty("config");
    expect(container).toHaveProperty("logger");
    expect(container).toHaveProperty("status");
    expect(container).toHaveProperty("knowledgeRepo");
    expect(container).toHaveProperty("knowledgeService");
    expect(container).toHaveProperty("workRepo");
    expect(container).toHaveProperty("workService");
    expect(container).toHaveProperty("searchRepo");
    expect(container).toHaveProperty("searchService");
    expect(container).toHaveProperty("orchestrationRepo");
    expect(container).toHaveProperty("agentsService");
    expect(container).toHaveProperty("ingestService");
    expect(container).toHaveProperty("dispose");
    await container.dispose();
  });

  it("container has the correct config", async () => {
    const container = await createContainer(testConfig);
    expect(container.config).toBe(testConfig);
    expect(container.config.repoPath).toBe("/tmp/monsthera-test");
    await container.dispose();
  });

  it("container has a functional logger", async () => {
    const container = await createContainer(testConfig);
    expect(container.logger).toBeDefined();
    expect(typeof container.logger.info).toBe("function");
    expect(typeof container.logger.warn).toBe("function");
    expect(typeof container.logger.error).toBe("function");
    expect(typeof container.logger.debug).toBe("function");
    await container.dispose();
  });

  it("container has a functional status reporter", async () => {
    const container = await createContainer(testConfig);
    expect(container.status).toBeDefined();
    expect(typeof container.status.getStatus).toBe("function");
    await container.dispose();
  });

  it("status reporter returns the correct version", async () => {
    const container = await createContainer(testConfig);
    const status = container.status.getStatus();
    expect(status.version).toBe(VERSION);
    await container.dispose();
  });

  it("status reporter includes storage subsystem", async () => {
    const container = await createContainer(testConfig);
    const status = container.status.getStatus();
    const storageSubsystem = status.subsystems.find((s) => s.name === "storage");
    const agentsSubsystem = status.subsystems.find((s) => s.name === "agents");
    const ingestSubsystem = status.subsystems.find((s) => s.name === "ingest");
    expect(storageSubsystem).toBeDefined();
    expect(storageSubsystem?.healthy).toBe(true);
    expect(agentsSubsystem).toBeDefined();
    expect(agentsSubsystem?.healthy).toBe(true);
    expect(ingestSubsystem).toBeDefined();
    expect(ingestSubsystem?.healthy).toBe(true);
    await container.dispose();
  });

  it("container has all repositories", async () => {
    const container = await createContainer(testConfig);
    expect(container.knowledgeRepo).toBeDefined();
    expect(container.workRepo).toBeDefined();
    expect(container.searchRepo).toBeDefined();
    expect(container.orchestrationRepo).toBeDefined();
    await container.dispose();
  });

  it("orchestrationRepo is a working in-memory implementation", async () => {
    const container = await createContainer(testConfig);
    const result = await container.orchestrationRepo.findRecent(10);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
    await container.dispose();
  });

  it("dispose() completes without error", async () => {
    const container = await createContainer(testConfig);
    await expect(container.dispose()).resolves.toBeUndefined();
  });

  it("dispose() can be called multiple times without error", async () => {
    const container = await createContainer(testConfig);
    await container.dispose();
    await expect(container.dispose()).resolves.toBeUndefined();
  });

  it("auto-reindex on startup overwrites persisted runtime-state stats", async () => {
    const repoPath = path.join("/tmp", `monsthera-runtime-${randomUUID()}`);
    const config = defaultConfig(repoPath);
    await fs.mkdir(path.join(repoPath, ".monsthera"), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, ".monsthera", "runtime-state.json"),
      JSON.stringify({ lastReindexAt: "2026-04-09T00:00:00Z", searchIndexSize: 42 }, null, 2),
      "utf-8",
    );

    const container = await createContainer(config);
    const status = container.status.getStatus();
    // Auto-reindex on startup overwrites persisted stats with fresh values
    expect(status.stats?.lastReindexAt).toBeDefined();
    expect(status.stats?.lastReindexAt).not.toBe("2026-04-09T00:00:00Z");
    expect(status.stats?.searchIndexSize).toBe(0); // empty repo has no articles
    await container.dispose();
    await fs.rm(repoPath, { recursive: true, force: true });
  });
});

describe("createTestContainer()", () => {
  it("returns a working container", async () => {
    const container = await createTestContainer();
    expect(container).toBeDefined();
    expect(container.config).toBeDefined();
    expect(container.logger).toBeDefined();
    expect(container.status).toBeDefined();
    await container.dispose();
  });

  it("uses /tmp/monsthera-test as the default repo path", async () => {
    const container = await createTestContainer();
    expect(container.config.repoPath).toMatch(/^\/tmp\/monsthera-test-/);
    await container.dispose();
  });

  it("accepts overrides for any container field", async () => {
    const mockLogger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => mockLogger,
    };
    const container = await createTestContainer({ logger: mockLogger });
    expect(container.logger).toBe(mockLogger);
    await container.dispose();
  });

  it("overrides don't affect other fields", async () => {
    const customConfig = defaultConfig("/custom/path");
    const container = await createTestContainer({ config: customConfig });
    expect(container.config.repoPath).toBe("/custom/path");
    // Other fields should still be present
    expect(container.logger).toBeDefined();
    expect(container.status).toBeDefined();
    await container.dispose();
  });
});
