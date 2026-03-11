import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { DEFAULT_AGORA_DIR, DEFAULT_DASHBOARD_PORT, DEFAULT_DB_NAME } from "./constants.js";

export const RegistrationRoleTokensSchema = z.object({
  developer: z.string().min(1).optional(),
  reviewer: z.string().min(1).optional(),
  observer: z.string().min(1).optional(),
  admin: z.string().min(1).optional(),
});

export const RegistrationAuthSchema = z.object({
  enabled: z.boolean().default(false),
  observerOpenRegistration: z.boolean().default(true),
  roleTokens: RegistrationRoleTokensSchema.default({}),
});

export const SecretPatternRuleSchema = z.object({
  name: z.string().min(1),
  pattern: z.string().min(1),
  flags: z.string().regex(/^[dgimsuvy]*$/).optional(),
});

export const ToolRateLimitConfigSchema = z.object({
  defaultPerMinute: z.number().int().min(1).max(1_000).default(10),
  overrides: z.record(z.string().min(1), z.number().int().min(1).max(1_000)).default({}),
});

export const CrossInstanceCapabilitySchema = z.enum([
  "read_code",
  "read_knowledge",
  "read_tickets",
]);

export const CrossInstanceInstanceIdSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/, "instanceId must be a stable lowercase slug");

export const CrossInstancePeerSchema = z.object({
  instanceId: CrossInstanceInstanceIdSchema,
  baseUrl: z.string().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "baseUrl must use http or https"),
  enabled: z.boolean().default(true),
  sharedSecret: z.string().min(16),
  nextSharedSecret: z.string().min(16).optional(),
  allowedCapabilities: z.array(CrossInstanceCapabilitySchema).default([]),
});

export const CrossInstanceConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    instanceId: CrossInstanceInstanceIdSchema.optional(),
    timestampSkewSeconds: z.number().int().min(1).max(600).default(120),
    nonceTtlSeconds: z.number().int().min(60).max(3600).default(600),
    peers: z.array(CrossInstancePeerSchema).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && !value.instanceId) {
      ctx.addIssue({
        code: "custom",
        path: ["instanceId"],
        message: "instanceId is required when crossInstance.enabled is true",
      });
    }

    const peerIds = new Set<string>();
    for (const peer of value.peers) {
      if (value.instanceId && peer.instanceId === value.instanceId) {
        ctx.addIssue({
          code: "custom",
          path: ["peers"],
          message: "peer instanceId cannot match the local instanceId",
        });
      }
      if (peerIds.has(peer.instanceId)) {
        ctx.addIssue({
          code: "custom",
          path: ["peers"],
          message: `duplicate peer instanceId: ${peer.instanceId}`,
        });
      }
      peerIds.add(peer.instanceId);
    }
  });

export const AgoraConfigSchema = z.object({
  repoPath: z.string(),
  agoraDir: z.string().default(DEFAULT_AGORA_DIR),
  dbName: z.string().default(DEFAULT_DB_NAME),
  dashboardPort: z.number().int().min(1024).max(65535).default(DEFAULT_DASHBOARD_PORT),
  verbosity: z.enum(["quiet", "normal", "verbose"]).default("normal"),
  debugLogging: z.boolean().default(false),
  coordinationTopology: z.enum(["hub-spoke", "hybrid", "mesh"]).default("hub-spoke"),
  sensitiveFilePatterns: z
    .array(z.string())
    .default([".env", ".env.*", "*.key", "*.pem", "credentials.*", "secrets.*"]),
  secretPatterns: z
    .array(SecretPatternRuleSchema)
    .default([]),
  excludePatterns: z
    .array(z.string())
    .default([
      "*.png", "*.jpg", "*.jpeg", "*.gif", "*.svg", "*.ico", "*.webp", "*.bmp", "*.tiff", "*.icns",
      "*.woff", "*.woff2", "*.ttf", "*.eot", "*.otf",
      "*.mp3", "*.mp4", "*.wav", "*.avi", "*.mov", "*.webm",
      "*.zip", "*.tar", "*.gz", "*.bz2", "*.7z", "*.rar",
      "*.pdf", "*.doc", "*.docx", "*.xls", "*.xlsx",
      "*.exe", "*.dll", "*.so", "*.dylib", "*.o", "*.a",
      "*.pyc", "*.pyo", "*.class", "*.jar", "*.wasm",
      "*.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
      "*.min.js", "*.min.css", "*.map",
    ]),
  zoektEnabled: z.boolean().default(true),
  transport: z.enum(["stdio", "http"]).default("stdio"),
  httpPort: z.number().int().min(1024).max(65535).default(3000),
  noDashboard: z.boolean().default(false),
  semanticEnabled: z.boolean().default(false),
  registrationAuth: RegistrationAuthSchema.default({
    enabled: false,
    observerOpenRegistration: true,
    roleTokens: {},
  }),
  crossInstance: CrossInstanceConfigSchema.default({
    enabled: false,
    timestampSkewSeconds: 120,
    nonceTtlSeconds: 600,
    peers: [],
  }),
  toolRateLimits: ToolRateLimitConfigSchema.default({
    defaultPerMinute: 10,
    overrides: {},
  }),
});

export type AgoraConfig = z.infer<typeof AgoraConfigSchema>;
export type RegistrationAuth = z.infer<typeof RegistrationAuthSchema>;
export type SecretPatternRule = z.infer<typeof SecretPatternRuleSchema>;
export type ToolRateLimitConfig = z.infer<typeof ToolRateLimitConfigSchema>;
export type CrossInstanceCapability = z.infer<typeof CrossInstanceCapabilitySchema>;
export type CrossInstancePeer = z.infer<typeof CrossInstancePeerSchema>;
export type CrossInstanceConfig = z.infer<typeof CrossInstanceConfigSchema>;

export function resolveConfig(partial: Partial<AgoraConfig> & { repoPath: string }): AgoraConfig {
  return AgoraConfigSchema.parse(partial);
}

export function loadConfigFile(repoPath: string, agoraDir = DEFAULT_AGORA_DIR): Partial<AgoraConfig> {
  const configPath = join(repoPath, agoraDir, "config.json");
  if (!existsSync(configPath)) {
    return {};
  }

  const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid Agora config at ${configPath}: expected an object`);
  }

  return parsed as Partial<AgoraConfig>;
}

export function mergeConfigSources(
  ...sources: Array<Partial<AgoraConfig> | undefined>
): Partial<AgoraConfig> {
  const merged: Partial<AgoraConfig> = {};

  for (const source of sources) {
    if (!source) continue;

    const { registrationAuth, crossInstance, toolRateLimits, ...rest } = source;
    Object.assign(merged, rest);

    if (registrationAuth) {
      merged.registrationAuth = {
        ...(merged.registrationAuth ?? {}),
        ...registrationAuth,
        roleTokens: {
          ...(merged.registrationAuth?.roleTokens ?? {}),
          ...(registrationAuth.roleTokens ?? {}),
        },
      };
    }

    if (crossInstance) {
      merged.crossInstance = {
        ...(merged.crossInstance ?? {}),
        ...crossInstance,
        peers: crossInstance.peers ?? merged.crossInstance?.peers ?? [],
      };
    }

    if (toolRateLimits) {
      merged.toolRateLimits = {
        ...(merged.toolRateLimits ?? {}),
        ...toolRateLimits,
        overrides: {
          ...(merged.toolRateLimits?.overrides ?? {}),
          ...(toolRateLimits.overrides ?? {}),
        },
      };
    }
  }

  return merged;
}
