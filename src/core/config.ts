import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { DEFAULT_AGORA_DIR, DEFAULT_DASHBOARD_PORT, DEFAULT_DB_NAME } from "./constants.js";
import {
  DEFAULT_CONFIG_FILE_PENALTY_FACTOR,
  DEFAULT_FILE_BM25_WEIGHTS,
  DEFAULT_KNOWLEDGE_BM25_WEIGHTS,
  DEFAULT_MIN_RELEVANCE_SCORE,
  DEFAULT_MIN_RELEVANCE_SCORE_SCOPED,
  DEFAULT_SEARCH_CONFIG,
  DEFAULT_SEMANTIC_BLEND_ALPHA,
  DEFAULT_TEST_FILE_PENALTY_FACTOR,
  DEFAULT_TICKET_BM25_WEIGHTS,
  DEFAULT_AND_QUERY_TERM_THRESHOLD,
} from "../search/constants.js";

export const RegistrationRoleTokensSchema = z.object({
  developer: z.string().min(1).optional(),
  reviewer: z.string().min(1).optional(),
  facilitator: z.string().min(1).optional(),
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

export const SearchFileBm25WeightsSchema = z.object({
  path: z.number().positive().max(10).default(DEFAULT_FILE_BM25_WEIGHTS.path),
  summary: z.number().positive().max(10).default(DEFAULT_FILE_BM25_WEIGHTS.summary),
  symbols: z.number().positive().max(10).default(DEFAULT_FILE_BM25_WEIGHTS.symbols),
});

export const SearchTicketBm25WeightsSchema = z.object({
  ticketId: z.number().positive().max(10).default(DEFAULT_TICKET_BM25_WEIGHTS.ticketId),
  title: z.number().positive().max(10).default(DEFAULT_TICKET_BM25_WEIGHTS.title),
  description: z.number().positive().max(10).default(DEFAULT_TICKET_BM25_WEIGHTS.description),
  tags: z.number().positive().max(10).default(DEFAULT_TICKET_BM25_WEIGHTS.tags),
});

export const SearchKnowledgeBm25WeightsSchema = z.object({
  title: z.number().positive().max(10).default(DEFAULT_KNOWLEDGE_BM25_WEIGHTS.title),
  content: z.number().positive().max(10).default(DEFAULT_KNOWLEDGE_BM25_WEIGHTS.content),
});

export const SearchPenaltyConfigSchema = z.object({
  testFiles: z.number().min(0).max(1).default(DEFAULT_TEST_FILE_PENALTY_FACTOR),
  configFiles: z.number().min(0).max(1).default(DEFAULT_CONFIG_FILE_PENALTY_FACTOR),
});

export const SearchThresholdConfigSchema = z.object({
  relevance: z.number().min(0).max(1).default(DEFAULT_MIN_RELEVANCE_SCORE),
  scopedRelevance: z.number().min(0).max(1).default(DEFAULT_MIN_RELEVANCE_SCORE_SCOPED),
  andQueryTermCount: z.number().int().min(1).max(10).default(DEFAULT_AND_QUERY_TERM_THRESHOLD),
});

export const SearchConfigSchema = z.object({
  semanticBlendAlpha: z.number().min(0).max(1).default(DEFAULT_SEMANTIC_BLEND_ALPHA),
  bm25: z.object({
    file: SearchFileBm25WeightsSchema.default(DEFAULT_SEARCH_CONFIG.bm25.file),
    ticket: SearchTicketBm25WeightsSchema.default(DEFAULT_SEARCH_CONFIG.bm25.ticket),
    knowledge: SearchKnowledgeBm25WeightsSchema.default(DEFAULT_SEARCH_CONFIG.bm25.knowledge),
  }).default(DEFAULT_SEARCH_CONFIG.bm25),
  penalties: SearchPenaltyConfigSchema.default(DEFAULT_SEARCH_CONFIG.penalties),
  thresholds: SearchThresholdConfigSchema.default(DEFAULT_SEARCH_CONFIG.thresholds),
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
  search: SearchConfigSchema.default(DEFAULT_SEARCH_CONFIG),
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
export type SearchConfig = z.infer<typeof SearchConfigSchema>;
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

    const { registrationAuth, crossInstance, toolRateLimits, search, ...rest } = source;
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

    if (search) {
      const mergedBm25 = {
        ...(merged.search?.bm25 ?? {}),
        ...(search.bm25 ?? {}),
        ...(search.bm25?.file || merged.search?.bm25?.file
          ? {
              file: {
                ...(merged.search?.bm25?.file ?? {}),
                ...(search.bm25?.file ?? {}),
              },
            }
          : {}),
        ...(search.bm25?.ticket || merged.search?.bm25?.ticket
          ? {
              ticket: {
                ...(merged.search?.bm25?.ticket ?? {}),
                ...(search.bm25?.ticket ?? {}),
              },
            }
          : {}),
        ...(search.bm25?.knowledge || merged.search?.bm25?.knowledge
          ? {
              knowledge: {
                ...(merged.search?.bm25?.knowledge ?? {}),
                ...(search.bm25?.knowledge ?? {}),
              },
            }
          : {}),
      };

      merged.search = {
        ...(merged.search ?? {}),
        ...search,
        ...(search.bm25 || merged.search?.bm25 ? { bm25: mergedBm25 } : {}),
        penalties: {
          ...(merged.search?.penalties ?? {}),
          ...(search.penalties ?? {}),
        },
        thresholds: {
          ...(merged.search?.thresholds ?? {}),
          ...(search.thresholds ?? {}),
        },
      };
    }
  }

  return merged;
}
