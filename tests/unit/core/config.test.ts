import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  defaultConfig,
  validateConfig,
  applyEnvOverrides,
  loadConfig,
  MonstheraConfigSchema,
} from "../../../src/core/config.js";

// ─── defaultConfig() ─────────────────────────────────────────────────────────

describe("defaultConfig()", () => {
  it("returns a valid config with all defaults", () => {
    const config = defaultConfig("/some/repo");
    expect(config.repoPath).toBe("/some/repo");
    expect(config.verbosity).toBe("normal");
    expect(config.storage.markdownRoot).toBe("knowledge");
    expect(config.storage.doltEnabled).toBe(false);
    expect(config.storage.doltHost).toBe("localhost");
    expect(config.storage.doltPort).toBe(3306);
    expect(config.storage.doltDatabase).toBe("monsthera");
    expect(config.storage.doltUser).toBe("root");
    expect(config.storage.doltPassword).toBe("");
    expect(config.search.semanticEnabled).toBe(true);
    expect(config.search.embeddingModel).toBe("nomic-embed-text");
    expect(config.search.embeddingProvider).toBe("ollama");
    expect(config.search.alpha).toBe(0.5);
    expect(config.search.ollamaUrl).toBe("http://localhost:11434");
    expect(config.orchestration.autoAdvance).toBe(false);
    expect(config.orchestration.pollIntervalMs).toBe(30000);
    expect(config.orchestration.maxConcurrentAgents).toBe(5);
    expect(config.server.port).toBe(3000);
    expect(config.server.host).toBe("localhost");
  });
});

// ─── validateConfig() ────────────────────────────────────────────────────────

describe("validateConfig()", () => {
  it("accepts a valid config object", () => {
    const result = validateConfig({ repoPath: "/my/project" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repoPath).toBe("/my/project");
    }
  });

  it("rejects config missing repoPath", () => {
    const result = validateConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ConfigurationError");
      expect(result.error.message).toMatch(/invalid configuration/i);
    }
  });

  it("applies defaults for optional sections", () => {
    const result = validateConfig({ repoPath: "/repo" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // All optional sections should have defaults
      expect(result.value.storage).toBeDefined();
      expect(result.value.search).toBeDefined();
      expect(result.value.orchestration).toBeDefined();
      expect(result.value.server).toBeDefined();
      expect(result.value.verbosity).toBe("normal");
    }
  });

  it("accepts a fully specified config", () => {
    const result = validateConfig({
      repoPath: "/repo",
      verbosity: "debug",
      storage: {
        markdownRoot: "docs",
        doltEnabled: true,
        doltHost: "db",
        doltPort: 3306,
        doltDatabase: "test",
        doltUser: "monsthera",
        doltPassword: "secret",
      },
      search: {
        semanticEnabled: false,
        embeddingModel: "custom-model",
        embeddingProvider: "huggingface",
        alpha: 0.7,
        ollamaUrl: "http://remote:11434",
      },
      orchestration: { autoAdvance: true, pollIntervalMs: 5000, maxConcurrentAgents: 10 },
      server: { port: 8080, host: "0.0.0.0" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verbosity).toBe("debug");
      expect(result.value.server.port).toBe(8080);
    }
  });
});

// ─── applyEnvOverrides() ─────────────────────────────────────────────────────

describe("applyEnvOverrides()", () => {
  beforeEach(() => {
    // Clean up relevant env vars before each test
    delete process.env["MONSTHERA_VERBOSITY"];
    delete process.env["MONSTHERA_PORT"];
    delete process.env["MONSTHERA_HOST"];
    delete process.env["MONSTHERA_DOLT_ENABLED"];
    delete process.env["MONSTHERA_MARKDOWN_ROOT"];
    delete process.env["MONSTHERA_DOLT_HOST"];
    delete process.env["MONSTHERA_DOLT_PORT"];
    delete process.env["MONSTHERA_DOLT_DATABASE"];
    delete process.env["MONSTHERA_DOLT_USER"];
    delete process.env["MONSTHERA_DOLT_PASSWORD"];
    delete process.env["MONSTHERA_SEMANTIC_ENABLED"];
    delete process.env["MONSTHERA_EMBEDDING_MODEL"];
    delete process.env["MONSTHERA_OLLAMA_URL"];
  });

  afterEach(() => {
    // Restore after each test
    delete process.env["MONSTHERA_VERBOSITY"];
    delete process.env["MONSTHERA_PORT"];
    delete process.env["MONSTHERA_HOST"];
    delete process.env["MONSTHERA_DOLT_ENABLED"];
    delete process.env["MONSTHERA_MARKDOWN_ROOT"];
    delete process.env["MONSTHERA_DOLT_HOST"];
    delete process.env["MONSTHERA_DOLT_PORT"];
    delete process.env["MONSTHERA_DOLT_DATABASE"];
    delete process.env["MONSTHERA_DOLT_USER"];
    delete process.env["MONSTHERA_DOLT_PASSWORD"];
    delete process.env["MONSTHERA_SEMANTIC_ENABLED"];
    delete process.env["MONSTHERA_EMBEDDING_MODEL"];
    delete process.env["MONSTHERA_OLLAMA_URL"];
  });

  it("merges MONSTHERA_VERBOSITY", () => {
    process.env["MONSTHERA_VERBOSITY"] = "debug";
    const result = applyEnvOverrides({ repoPath: "/repo" });
    expect(result["verbosity"]).toBe("debug");
  });

  it("merges MONSTHERA_PORT as a number", () => {
    process.env["MONSTHERA_PORT"] = "8080";
    const result = applyEnvOverrides({ repoPath: "/repo" });
    expect(typeof (result["server"] as Record<string, unknown>)?.["port"]).toBe("number");
    expect((result["server"] as Record<string, unknown>)?.["port"]).toBe(8080);
  });

  it("does not override when env vars are not set", () => {
    const base = { repoPath: "/repo", verbosity: "quiet" };
    const result = applyEnvOverrides(base);
    expect(result["verbosity"]).toBe("quiet");
  });

  it("merges MONSTHERA_DOLT_ENABLED as boolean", () => {
    process.env["MONSTHERA_DOLT_ENABLED"] = "true";
    const result = applyEnvOverrides({ repoPath: "/repo" });
    expect((result["storage"] as Record<string, unknown>)?.["doltEnabled"]).toBe(true);
  });

  it("preserves existing server config when setting port", () => {
    process.env["MONSTHERA_PORT"] = "9000";
    const result = applyEnvOverrides({ repoPath: "/repo", server: { host: "0.0.0.0", port: 3000 } });
    const server = result["server"] as Record<string, unknown>;
    expect(server["host"]).toBe("0.0.0.0");
    expect(server["port"]).toBe(9000);
  });

  it("merges Dolt connection settings", () => {
    process.env["MONSTHERA_DOLT_HOST"] = "127.0.0.1";
    process.env["MONSTHERA_DOLT_PORT"] = "3310";
    process.env["MONSTHERA_DOLT_DATABASE"] = "monsthera_local";
    process.env["MONSTHERA_DOLT_USER"] = "root";
    process.env["MONSTHERA_DOLT_PASSWORD"] = "password";

    const result = applyEnvOverrides({ repoPath: "/repo" });
    const storage = result["storage"] as Record<string, unknown>;
    expect(storage["doltHost"]).toBe("127.0.0.1");
    expect(storage["doltPort"]).toBe(3310);
    expect(storage["doltDatabase"]).toBe("monsthera_local");
    expect(storage["doltUser"]).toBe("root");
    expect(storage["doltPassword"]).toBe("password");
  });
});

// ─── loadConfig() ────────────────────────────────────────────────────────────

describe("loadConfig()", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "monsthera-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", () => {
    const result = loadConfig(tmpDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.repoPath).toBe(tmpDir);
      expect(result.value.verbosity).toBe("normal");
      expect(result.value.server.port).toBe(3000);
    }
  });

  it("reads config from file when it exists", () => {
    const configDir = path.join(tmpDir, ".monsthera");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ verbosity: "verbose", server: { port: 9999 } }),
      "utf-8",
    );

    const result = loadConfig(tmpDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.verbosity).toBe("verbose");
      expect(result.value.server.port).toBe(9999);
      expect(result.value.repoPath).toBe(tmpDir);
    }
  });

  it("returns error for malformed JSON", () => {
    const configDir = path.join(tmpDir, ".monsthera");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), "{ this is not valid json }", "utf-8");

    const result = loadConfig(tmpDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("ConfigurationError");
      expect(result.error.message).toMatch(/malformed json/i);
    }
  });
});

// ─── Schema validation edge cases ────────────────────────────────────────────

describe("MonstheraConfigSchema", () => {
  it("rejects invalid verbosity level", () => {
    const result = MonstheraConfigSchema.safeParse({
      repoPath: "/repo",
      verbosity: "super-verbose",
    });
    expect(result.success).toBe(false);
  });

  it("rejects alpha out of 0-1 range (above 1)", () => {
    const result = MonstheraConfigSchema.safeParse({
      repoPath: "/repo",
      search: { alpha: 1.5 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects alpha out of 0-1 range (below 0)", () => {
    const result = MonstheraConfigSchema.safeParse({
      repoPath: "/repo",
      search: { alpha: -0.1 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects pollIntervalMs below minimum (1000)", () => {
    const result = MonstheraConfigSchema.safeParse({
      repoPath: "/repo",
      orchestration: { pollIntervalMs: 500 },
    });
    expect(result.success).toBe(false);
  });
});
