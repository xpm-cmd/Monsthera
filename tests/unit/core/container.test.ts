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

  it("boot reports the live search index size instead of stale persisted size", async () => {
    const repoPath = path.join("/tmp", `monsthera-runtime-${randomUUID()}`);
    const config = defaultConfig(repoPath);
    config.search.semanticEnabled = false;
    await fs.mkdir(path.join(repoPath, ".monsthera"), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, ".monsthera", "runtime-state.json"),
      JSON.stringify({ lastReindexAt: "2026-04-09T00:00:00Z", searchIndexSize: 42 }, null, 2),
      "utf-8",
    );

    const container = await createContainer(config);
    const status = container.status.getStatus();
    expect(status.stats?.lastReindexAt).toBe("2026-04-09T00:00:00Z");
    expect(status.stats?.searchIndexSize).toBe(0);
    await container.dispose();
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("boot rehydrates the in-memory search index from source articles", async () => {
    const repoPath = path.join("/tmp", `monsthera-runtime-${randomUUID()}`);
    const config = defaultConfig(repoPath);
    config.search.semanticEnabled = false;

    const firstBoot = await createContainer(config);
    const articleResult = await firstBoot.knowledgeRepo.create({
      title: "Context Pack Builder",
      category: "context",
      content: "How build_context_pack scores and ranks knowledge items.",
    });
    expect(articleResult.ok).toBe(true);
    await firstBoot.dispose();

    await fs.mkdir(path.join(repoPath, ".monsthera"), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, ".monsthera", "runtime-state.json"),
      JSON.stringify({ lastReindexAt: "2026-04-09T00:00:00Z", searchIndexSize: 42 }, null, 2),
      "utf-8",
    );

    const secondBoot = await createContainer(config);
    const status = secondBoot.status.getStatus();
    expect(status.stats?.searchIndexSize).toBe(1);
    expect(status.stats?.lastReindexAt).toBeTruthy();

    const searchResult = await secondBoot.searchService.search({ query: "context pack builder" });
    expect(searchResult.ok).toBe(true);
    if (searchResult.ok) {
      expect(searchResult.value.some((item) => item.title === "Context Pack Builder")).toBe(true);
    }

    await secondBoot.dispose();
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("boot does NOT write runtime-state.json when only the in-memory bootstrap reindex runs", async () => {
    const repoPath = path.join("/tmp", `monsthera-runtime-${randomUUID()}`);
    const config = defaultConfig(repoPath);
    config.search.semanticEnabled = false;

    // Seed an article so the boot triggers a bootstrap reindex.
    const seedBoot = await createContainer(config);
    const seedResult = await seedBoot.knowledgeRepo.create({
      title: "Boot stays read-only",
      category: "context",
      content: "Body so the article participates in the search index.",
    });
    expect(seedResult.ok).toBe(true);
    await seedBoot.dispose();

    // Remove any cache files written so far so we measure cleanly.
    await fs.rm(path.join(repoPath, ".monsthera", "cache"), { recursive: true, force: true });
    await fs.rm(path.join(repoPath, ".monsthera", "runtime-state.json"), { force: true });

    // Boot a fresh container — bootstrap reindex runs internally.
    const container = await createContainer(config);
    const status = container.status.getStatus();
    expect(status.stats?.searchIndexSize).toBe(1);
    // lastReindexAt must be absent: no explicit reindex has happened yet.
    expect(status.stats?.lastReindexAt).toBeUndefined();

    await expect(
      fs.access(path.join(repoPath, ".monsthera", "cache", "runtime-state.json")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(repoPath, ".monsthera", "runtime-state.json")),
    ).rejects.toThrow();

    await container.dispose();
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("writes runtime-state.json under .monsthera/cache/ and migrates the legacy file away", async () => {
    const repoPath = path.join("/tmp", `monsthera-runtime-${randomUUID()}`);
    const config = defaultConfig(repoPath);
    config.search.semanticEnabled = false;

    // Seed the legacy location to simulate an upgrade from a prior version.
    await fs.mkdir(path.join(repoPath, ".monsthera"), { recursive: true });
    const legacyPath = path.join(repoPath, ".monsthera", "runtime-state.json");
    const newPath = path.join(repoPath, ".monsthera", "cache", "runtime-state.json");
    await fs.writeFile(
      legacyPath,
      JSON.stringify({ lastReindexAt: "2026-04-09T00:00:00Z", searchIndexSize: 99 }, null, 2),
      "utf-8",
    );

    // Boot creates an article, which triggers a reindex and a runtime-state write.
    const container = await createContainer(config);
    const articleResult = await container.knowledgeRepo.create({
      title: "Migration target",
      category: "context",
      content: "Just enough body to participate in the search index.",
    });
    expect(articleResult.ok).toBe(true);
    const reindexResult = await container.searchService.fullReindex();
    expect(reindexResult.ok).toBe(true);

    await expect(fs.access(newPath)).resolves.toBeUndefined();
    await expect(fs.access(legacyPath)).rejects.toThrow();

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
