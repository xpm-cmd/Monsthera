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
    expect(container).toHaveProperty("workRepo");
    expect(container).toHaveProperty("searchRepo");
    expect(container).toHaveProperty("orchestrationRepo");
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
    expect(storageSubsystem).toBeDefined();
    expect(storageSubsystem?.healthy).toBe(true);
    await container.dispose();
  });

  it("container has stub repositories", async () => {
    const container = await createContainer(testConfig);
    expect(container.knowledgeRepo).toBeDefined();
    expect(container.workRepo).toBeDefined();
    expect(container.searchRepo).toBeDefined();
    expect(container.orchestrationRepo).toBeDefined();
    await container.dispose();
  });

  it("stub repo methods throw 'not implemented'", async () => {
    const container = await createContainer(testConfig);
    expect(() => container.knowledgeRepo.findBySlug("test" as Parameters<typeof container.knowledgeRepo.findBySlug>[0])).toThrow(
      "KnowledgeArticleRepository.findBySlug() is not implemented (Phase 1 stub)",
    );
    expect(() => container.workRepo.findActive()).toThrow(
      "WorkArticleRepository.findActive() is not implemented (Phase 1 stub)",
    );
    expect(() => container.searchRepo.reindex()).toThrow(
      "SearchIndexRepository.reindex() is not implemented (Phase 1 stub)",
    );
    expect(() => container.orchestrationRepo.findRecent(10)).toThrow(
      "OrchestrationEventRepository.findRecent() is not implemented (Phase 1 stub)",
    );
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
    expect(container.config.repoPath).toBe("/tmp/monsthera-test");
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
