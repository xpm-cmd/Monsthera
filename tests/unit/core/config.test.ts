import { describe, it, expect } from "vitest";
import {
  AgoraConfigSchema,
  resolveConfig,
  mergeConfigSources,
} from "../../../src/core/config.js";

describe("AgoraConfigSchema", () => {
  it("parses valid config with only repoPath", () => {
    const result = AgoraConfigSchema.parse({ repoPath: "/test/repo" });

    expect(result.repoPath).toBe("/test/repo");
    expect(result.verbosity).toBe("normal");
    expect(result.debugLogging).toBe(false);
    expect(result.transport).toBe("stdio");
    expect(result.coordinationTopology).toBe("hub-spoke");
    expect(result.semanticEnabled).toBe(false);
    expect(result.zoektEnabled).toBe(true);
    expect(result.noDashboard).toBe(false);
  });

  it("applies default values for all optional fields", () => {
    const result = AgoraConfigSchema.parse({ repoPath: "/r" });

    expect(result.agoraDir).toBe(".agora");
    expect(result.dbName).toBe("agora.db");
    expect(result.dashboardPort).toBeGreaterThanOrEqual(1024);
    expect(result.httpPort).toBe(3000);
    expect(result.excludePatterns.length).toBeGreaterThan(0);
    expect(result.sensitiveFilePatterns).toContain(".env");
    expect(result.secretPatterns).toEqual([]);
  });

  it("rejects missing repoPath", () => {
    expect(() => AgoraConfigSchema.parse({})).toThrow();
  });

  it("rejects invalid dashboardPort (below 1024)", () => {
    expect(() => AgoraConfigSchema.parse({ repoPath: "/r", dashboardPort: 80 })).toThrow();
  });

  it("rejects invalid dashboardPort (above 65535)", () => {
    expect(() => AgoraConfigSchema.parse({ repoPath: "/r", dashboardPort: 70000 })).toThrow();
  });

  it("rejects invalid verbosity", () => {
    expect(() => AgoraConfigSchema.parse({ repoPath: "/r", verbosity: "debug" })).toThrow();
  });

  it("rejects invalid transport", () => {
    expect(() => AgoraConfigSchema.parse({ repoPath: "/r", transport: "grpc" })).toThrow();
  });

  it("accepts valid registrationAuth", () => {
    const result = AgoraConfigSchema.parse({
      repoPath: "/r",
      registrationAuth: {
        enabled: true,
        observerOpenRegistration: false,
        roleTokens: { developer: "secret-123" },
      },
    });

    expect(result.registrationAuth.enabled).toBe(true);
    expect(result.registrationAuth.observerOpenRegistration).toBe(false);
    expect(result.registrationAuth.roleTokens.developer).toBe("secret-123");
  });

  it("accepts valid toolRateLimits", () => {
    const result = AgoraConfigSchema.parse({
      repoPath: "/r",
      toolRateLimits: {
        defaultPerMinute: 20,
        overrides: { get_code_pack: 5, status: 100 },
      },
    });

    expect(result.toolRateLimits.defaultPerMinute).toBe(20);
    expect(result.toolRateLimits.overrides.get_code_pack).toBe(5);
    expect(result.toolRateLimits.overrides.status).toBe(100);
  });

  it("rejects toolRateLimits with rate below 1", () => {
    expect(() => AgoraConfigSchema.parse({
      repoPath: "/r",
      toolRateLimits: { defaultPerMinute: 0 },
    })).toThrow();
  });

  it("accepts custom secretPatterns", () => {
    const result = AgoraConfigSchema.parse({
      repoPath: "/r",
      secretPatterns: [{ name: "AWS Key", pattern: "AKIA[A-Z0-9]{16}", flags: "g" }],
    });

    expect(result.secretPatterns).toHaveLength(1);
    expect(result.secretPatterns[0]!.name).toBe("AWS Key");
  });

  it("rejects secretPatterns with invalid flags", () => {
    expect(() => AgoraConfigSchema.parse({
      repoPath: "/r",
      secretPatterns: [{ name: "Bad", pattern: ".*", flags: "xyz" }],
    })).toThrow();
  });
});

describe("resolveConfig", () => {
  it("returns a fully resolved config with defaults", () => {
    const config = resolveConfig({ repoPath: "/test" });

    expect(config.repoPath).toBe("/test");
    expect(config.verbosity).toBe("normal");
    expect(config.transport).toBe("stdio");
  });

  it("preserves explicit overrides", () => {
    const config = resolveConfig({
      repoPath: "/test",
      verbosity: "verbose",
      debugLogging: true,
    });

    expect(config.verbosity).toBe("verbose");
    expect(config.debugLogging).toBe(true);
  });
});

describe("mergeConfigSources", () => {
  it("returns empty object when no sources provided", () => {
    expect(mergeConfigSources()).toEqual({});
  });

  it("skips undefined sources", () => {
    const result = mergeConfigSources(undefined, { repoPath: "/r" }, undefined);
    expect(result.repoPath).toBe("/r");
  });

  it("later sources override earlier ones", () => {
    const result = mergeConfigSources(
      { repoPath: "/first", verbosity: "quiet" },
      { repoPath: "/second" },
    );

    expect(result.repoPath).toBe("/second");
    expect(result.verbosity).toBe("quiet");
  });

  it("deep-merges registrationAuth", () => {
    const result = mergeConfigSources(
      { registrationAuth: { enabled: false, roleTokens: { observer: "obs-token" } } } as Partial<any>,
      { registrationAuth: { enabled: true, roleTokens: { developer: "dev-token" } } } as Partial<any>,
    );

    expect(result.registrationAuth).toEqual({
      enabled: true,
      roleTokens: { observer: "obs-token", developer: "dev-token" },
    });
  });

  it("deep-merges toolRateLimits", () => {
    const result = mergeConfigSources(
      { toolRateLimits: { defaultPerMinute: 10, overrides: { status: 50 } } } as Partial<any>,
      { toolRateLimits: { defaultPerMinute: 20, overrides: { get_code_pack: 5 } } } as Partial<any>,
    );

    expect(result.toolRateLimits).toEqual({
      defaultPerMinute: 20,
      overrides: { status: 50, get_code_pack: 5 },
    });
  });

  it("does not clobber existing registrationAuth when source has no registrationAuth", () => {
    const result = mergeConfigSources(
      { registrationAuth: { enabled: true, roleTokens: { developer: "tok" } } } as Partial<any>,
      { verbosity: "verbose" },
    );

    expect(result.registrationAuth).toEqual({
      enabled: true,
      roleTokens: { developer: "tok" },
    });
  });
});
