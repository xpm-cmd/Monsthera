import { afterEach, describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AgoraConfigSchema,
  resolveConfig,
  mergeConfigSources,
  loadConfigFile,
} from "../../../src/core/config.js";
import { DEFAULT_SEARCH_CONFIG } from "../../../src/search/constants.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

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
    expect(result.crossInstance.enabled).toBe(false);
    expect(result.crossInstance.peers).toEqual([]);
    expect(result.search).toEqual(DEFAULT_SEARCH_CONFIG);
    expect(result.ticketQuorum.technicalAnalysisToApproved.enabled).toBe(true);
    expect(result.ticketQuorum.inReviewToReadyForCommit.vetoSpecializations).toEqual(["architect", "security"]);
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

  it("accepts valid search tuning config", () => {
    const result = AgoraConfigSchema.parse({
      repoPath: "/r",
      search: {
        semanticBlendAlpha: 0.65,
        bm25: {
          file: { path: 2.0, summary: 1.2, symbols: 2.5 },
        },
        penalties: {
          testFiles: 0.55,
        },
        thresholds: {
          andQueryTermCount: 2,
        },
      },
    });

    expect(result.search.semanticBlendAlpha).toBe(0.65);
    expect(result.search.bm25.file).toEqual({ path: 2.0, summary: 1.2, symbols: 2.5 });
    expect(result.search.bm25.ticket).toEqual(DEFAULT_SEARCH_CONFIG.bm25.ticket);
    expect(result.search.penalties.testFiles).toBe(0.55);
    expect(result.search.penalties.configFiles).toBe(DEFAULT_SEARCH_CONFIG.penalties.configFiles);
    expect(result.search.thresholds.andQueryTermCount).toBe(2);
  });

  it("accepts valid crossInstance config", () => {
    const result = AgoraConfigSchema.parse({
      repoPath: "/r",
      crossInstance: {
        enabled: true,
        instanceId: "agora-main",
        peers: [
          {
            instanceId: "agora-docs",
            baseUrl: "https://agora.example.test",
            sharedSecret: "1234567890abcdef",
            allowedCapabilities: ["read_code", "read_knowledge"],
          },
        ],
      },
    });

    expect(result.crossInstance.enabled).toBe(true);
    expect(result.crossInstance.instanceId).toBe("agora-main");
    expect(result.crossInstance.peers).toHaveLength(1);
    expect(result.crossInstance.peers[0]?.allowedCapabilities).toEqual(["read_code", "read_knowledge"]);
  });

  it("accepts valid ticketQuorum config", () => {
    const result = AgoraConfigSchema.parse({
      repoPath: "/r",
      ticketQuorum: {
        technicalAnalysisToApproved: {
          requiredPasses: 5,
          vetoSpecializations: ["security"],
        },
        inReviewToReadyForCommit: {
          enabled: false,
        },
      },
    });

    expect(result.ticketQuorum.technicalAnalysisToApproved.requiredPasses).toBe(5);
    expect(result.ticketQuorum.technicalAnalysisToApproved.vetoSpecializations).toEqual(["security"]);
    expect(result.ticketQuorum.inReviewToReadyForCommit.enabled).toBe(false);
  });

  it("rejects crossInstance enabled without instanceId", () => {
    expect(() => AgoraConfigSchema.parse({
      repoPath: "/r",
      crossInstance: {
        enabled: true,
      },
    })).toThrow(/instanceId is required/i);
  });

  it("rejects duplicate crossInstance peer ids", () => {
    expect(() => AgoraConfigSchema.parse({
      repoPath: "/r",
      crossInstance: {
        enabled: true,
        instanceId: "agora-main",
        peers: [
          {
            instanceId: "agora-peer",
            baseUrl: "https://one.example.test",
            sharedSecret: "1234567890abcdef",
          },
          {
            instanceId: "agora-peer",
            baseUrl: "https://two.example.test",
            sharedSecret: "abcdef1234567890",
          },
        ],
      },
    })).toThrow(/duplicate peer instanceId/i);
  });

  it("rejects ticketQuorum requiredPasses above council size", () => {
    expect(() => AgoraConfigSchema.parse({
      repoPath: "/r",
      ticketQuorum: {
        technicalAnalysisToApproved: {
          requiredPasses: 7,
        },
      },
    })).toThrow();
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

  it("rejects invalid search alpha", () => {
    expect(() => AgoraConfigSchema.parse({
      repoPath: "/r",
      search: { semanticBlendAlpha: 1.5 },
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

  it("deep-merges search tuning config", () => {
    const result = mergeConfigSources(
      {
        search: {
          semanticBlendAlpha: 0.55,
          bm25: { file: { path: 1.8 } },
        },
      } as Partial<any>,
      {
        search: {
          penalties: { testFiles: 0.6 },
          thresholds: { scopedRelevance: 0.25 },
        },
      } as Partial<any>,
    );

    expect(result.search).toEqual({
      semanticBlendAlpha: 0.55,
      bm25: { file: { path: 1.8 } },
      penalties: { testFiles: 0.6 },
      thresholds: { scopedRelevance: 0.25 },
    });
  });

  it("deep-merges crossInstance and preserves peers when later source omits them", () => {
    const result = mergeConfigSources(
      {
        crossInstance: {
          enabled: true,
          instanceId: "agora-main",
          peers: [{
            instanceId: "agora-peer",
            baseUrl: "https://peer.example.test",
            sharedSecret: "1234567890abcdef",
          }],
        },
      } as Partial<any>,
      {
        crossInstance: {
          nonceTtlSeconds: 900,
        },
      } as Partial<any>,
    );

    expect(result.crossInstance).toEqual({
      enabled: true,
      instanceId: "agora-main",
      nonceTtlSeconds: 900,
      peers: [{
        instanceId: "agora-peer",
        baseUrl: "https://peer.example.test",
        sharedSecret: "1234567890abcdef",
      }],
    });
  });

  it("deep-merges ticketQuorum rules by transition", () => {
    const result = mergeConfigSources(
      {
        ticketQuorum: {
          technicalAnalysisToApproved: {
            requiredPasses: 5,
            vetoSpecializations: ["security"],
          },
        },
      } as Partial<any>,
      {
        ticketQuorum: {
          inReviewToReadyForCommit: {
            enabled: false,
          },
        },
      } as Partial<any>,
    );

    expect(result.ticketQuorum).toEqual({
      technicalAnalysisToApproved: {
        requiredPasses: 5,
        vetoSpecializations: ["security"],
      },
      inReviewToReadyForCommit: {
        enabled: false,
      },
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

describe("loadConfigFile", () => {
  it("returns empty config when the file does not exist", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "agora-config-missing-"));
    tempDirs.push(repoPath);

    expect(loadConfigFile(repoPath)).toEqual({});
  });

  it("loads a valid config object from disk", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "agora-config-valid-"));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, ".agora"), { recursive: true });

    writeFileSync(
      join(repoPath, ".agora", "config.json"),
      JSON.stringify({
        verbosity: "verbose",
        registrationAuth: {
          enabled: true,
          roleTokens: { developer: "secret-123" },
        },
      }),
      { encoding: "utf-8" },
    );

    expect(loadConfigFile(repoPath)).toEqual({
      verbosity: "verbose",
      registrationAuth: {
        enabled: true,
        roleTokens: { developer: "secret-123" },
      },
    });
  });

  it("throws when config contains invalid JSON", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "agora-config-json-"));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, ".agora"), { recursive: true });

    writeFileSync(join(repoPath, ".agora", "config.json"), "{bad json", { encoding: "utf-8" });

    expect(() => loadConfigFile(repoPath)).toThrow();
  });

  it("throws when config is not an object", () => {
    const repoPath = mkdtempSync(join(tmpdir(), "agora-config-shape-"));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, ".agora"), { recursive: true });

    writeFileSync(join(repoPath, ".agora", "config.json"), JSON.stringify(["not", "an", "object"]), {
      encoding: "utf-8",
    });

    expect(() => loadConfigFile(repoPath)).toThrow(/expected an object/i);
  });
});
