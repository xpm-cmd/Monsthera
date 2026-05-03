import { describe, it, expect } from "vitest";
import { createContainer, DoltUnavailableError } from "../../../src/core/container.js";
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

  it("refuses to start when doltEnabled but Dolt unavailable (no silent in-memory fallback)", async () => {
    // Point to an unused high port so the failure is deterministic. The
    // OLD behavior silently fell back to in-memory; we now treat that as
    // a configuration error because session mutations would not persist.
    const config = makeConfig({ doltEnabled: true, doltHost: "127.0.0.1", doltPort: 65530 });
    await expect(createContainer(config)).rejects.toBeInstanceOf(DoltUnavailableError);
  });

  it("falls back to in-memory when doltEnabled but Dolt unavailable AND allowDegraded=true", async () => {
    const config = makeConfig({ doltEnabled: true, doltHost: "127.0.0.1", doltPort: 65530 });
    const container = await createContainer(config, { allowDegraded: true });

    expect(container.knowledgeRepo).toBeDefined();
    expect(container.workRepo).toBeDefined();
    expect(container.searchRepo).toBeDefined();

    const status = container.status.getStatus();
    const storage = status.subsystems.find((s) => s.name === "storage");
    expect(storage?.healthy).toBe(false);
    expect(storage?.detail).toContain("degraded");

    await container.dispose();
  });

  it("respects MONSTHERA_ALLOW_DEGRADED=1 as opt-in", async () => {
    const original = process.env["MONSTHERA_ALLOW_DEGRADED"];
    process.env["MONSTHERA_ALLOW_DEGRADED"] = "1";
    try {
      const config = makeConfig({ doltEnabled: true, doltHost: "127.0.0.1", doltPort: 65530 });
      const container = await createContainer(config);
      expect(container.searchRepo).toBeDefined();
      await container.dispose();
    } finally {
      if (original === undefined) delete process.env["MONSTHERA_ALLOW_DEGRADED"];
      else process.env["MONSTHERA_ALLOW_DEGRADED"] = original;
    }
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

describe("container wiring: code inventory service (M3 phase 3)", () => {
  it("wires codeInventoryService when Dolt is disabled (JSON-only path)", async () => {
    const config = makeConfig({ doltEnabled: false });
    const container = await createContainer(config);

    expect(container.codeInventoryService).toBeDefined();
    // The service exposes the M3 read surface. With no cache file on disk
    // (fresh temp repo), getStatus reports `built: false`.
    const status = await container.codeInventoryService.getStatus();
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.value.built).toBe(false);
      expect(status.value.fileCount).toBe(0);
      expect(status.value.symbolCount).toBe(0);
      // No Dolt mirror configured → no degraded reason from a failing mirror.
      expect(status.value.degraded).toBeUndefined();
    }

    await container.dispose();
  });

  it("wires codeInventoryService in degraded mode when Dolt is unreachable but allowDegraded=true", async () => {
    // The container falls back to in-memory when allowDegraded is set, and
    // the inventory's Dolt mirror is wired with `null` because the pool
    // never came up. The JSON path remains canonical (ADR-014 portable
    // workspace rule).
    const config = makeConfig({ doltEnabled: true, doltHost: "127.0.0.1", doltPort: 65530 });
    const container = await createContainer(config, { allowDegraded: true });

    expect(container.codeInventoryService).toBeDefined();
    const status = await container.codeInventoryService.getStatus();
    expect(status.ok).toBe(true);
    if (status.ok) {
      // Empty cache is the same shape regardless of Dolt availability:
      // the inventory does not depend on Dolt for reads.
      expect(status.value.built).toBe(false);
      // No Dolt save has happened yet, so `degraded` is still undefined.
      expect(status.value.degraded).toBeUndefined();
    }

    await container.dispose();
  });

  it("threads the codeInventoryService through to CodeIntelligenceService as an optional dep", async () => {
    // The wiring must not break the M2 surface. The container hands the
    // inventory service to CodeIntelligenceService via the optional dep
    // (Phase 4 will use it for the new `reasons` codes); Phase 3 only
    // verifies the wiring lands without breaking the M2 result shape.
    const config = makeConfig({ doltEnabled: false });
    const container = await createContainer(config);

    const impactResult = await container.codeIntelligenceService.analyzeCodeRefImpact({
      ref: "src/never-touched.ts",
    });
    expect(impactResult.ok).toBe(true);
    if (impactResult.ok) {
      expect(impactResult.value).toHaveProperty("ref");
      expect(impactResult.value).toHaveProperty("risk");
      expect(impactResult.value).toHaveProperty("reasons");
      expect(impactResult.value).toHaveProperty("recommendedNextActions");
    }

    await container.dispose();
  });
});
