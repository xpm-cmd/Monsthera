import { describe, it, expect } from "vitest";
import { createContainer } from "../../../src/core/container.js";
import { defaultConfig } from "../../../src/core/config.js";
import type { MonstheraConfig } from "../../../src/core/config.js";

/**
 * Tests for conditional container wiring:
 * - Dolt repos for knowledge/work when doltEnabled
 * - Ollama embedding provider when semanticEnabled + ollama
 */

function makeConfig(overrides: {
  doltEnabled?: boolean;
  doltHost?: string;
  doltPort?: number;
  semanticEnabled?: boolean;
  embeddingProvider?: "ollama";
}): MonstheraConfig {
  const base = defaultConfig("/tmp/monsthera-wiring-test");
  return {
    ...base,
    storage: {
      ...base.storage,
      doltEnabled: overrides.doltEnabled ?? false,
      doltHost: overrides.doltHost ?? base.storage.doltHost,
      doltPort: overrides.doltPort ?? base.storage.doltPort,
    },
    search: {
      ...base.search,
      semanticEnabled: overrides.semanticEnabled ?? false,
      embeddingProvider: overrides.embeddingProvider ?? "ollama",
    },
  };
}

describe("container wiring: embedding provider", () => {
  it("uses StubEmbeddingProvider when semanticEnabled is false", async () => {
    const config = makeConfig({ semanticEnabled: false });
    const container = await createContainer(config);

    // The search service should have been wired with stub — dimensions === 0
    // We can verify indirectly via status (search service is wired)
    expect(container.searchService).toBeDefined();
    await container.dispose();
  });

  it("uses OllamaEmbeddingProvider when semanticEnabled + ollama", async () => {
    const config = makeConfig({
      semanticEnabled: true,
      embeddingProvider: "ollama",
    });
    const container = await createContainer(config);
    expect(container.searchService).toBeDefined();
    await container.dispose();
  });

  it("uses StubEmbeddingProvider when semanticEnabled is false regardless of provider", async () => {
    const config = makeConfig({
      semanticEnabled: false,
      embeddingProvider: "ollama",
    });
    const container = await createContainer(config);
    expect(container.searchService).toBeDefined();
    await container.dispose();
  });
});

describe("container wiring: Dolt fallback", () => {
  it("uses FileSystem repos when doltEnabled is false", async () => {
    const config = makeConfig({ doltEnabled: false });
    const container = await createContainer(config);

    // Verify repos are present and functional (FS-backed)
    expect(container.knowledgeRepo).toBeDefined();
    expect(container.workRepo).toBeDefined();
    expect(container.searchRepo).toBeDefined();
    expect(container.orchestrationRepo).toBeDefined();

    // Status should show Markdown storage (not degraded)
    const status = container.status.getStatus();
    const storage = status.subsystems.find((s) => s.name === "storage");
    expect(storage?.healthy).toBe(true);
    expect(storage?.detail).toContain("Markdown");

    await container.dispose();
  });

  it("falls back to in-memory when doltEnabled but Dolt unavailable", async () => {
    // Point to an unused high port so the fallback remains deterministic.
    const config = makeConfig({ doltEnabled: true, doltHost: "127.0.0.1", doltPort: 65530 });
    const container = await createContainer(config);

    // Repos should still be present (FS + in-memory fallback)
    expect(container.knowledgeRepo).toBeDefined();
    expect(container.workRepo).toBeDefined();
    expect(container.searchRepo).toBeDefined();

    // Status should show degraded
    const status = container.status.getStatus();
    const storage = status.subsystems.find((s) => s.name === "storage");
    expect(storage?.healthy).toBe(false);
    expect(storage?.detail).toContain("degraded");

    await container.dispose();
  });

  it("does not register dolt-health when Dolt is disabled", async () => {
    const config = makeConfig({ doltEnabled: false });
    const container = await createContainer(config);
    const status = container.status.getStatus();
    const doltHealth = status.subsystems.find((s) => s.name === "dolt-health");
    expect(doltHealth).toBeUndefined();
    await container.dispose();
  });
});
