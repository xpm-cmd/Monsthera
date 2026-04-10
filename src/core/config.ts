import { z } from "zod/v4";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Result } from "./result.js";
import { ok, err } from "./result.js";
import { ConfigurationError } from "./errors.js";
import { DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILE } from "./constants.js";

// ─── Sub-schemas ─────────────────────────────────────────────────────────────

const StorageConfigSchema = z.object({
  markdownRoot: z.string().default("knowledge"),
  doltEnabled: z.boolean().default(false),
  doltHost: z.string().default("localhost"),
  doltPort: z.number().default(3306),
  doltDatabase: z.string().default("monsthera"),
  doltUser: z.string().default("root"),
  doltPassword: z.string().default(""),
});

const SearchConfigSchema = z.object({
  semanticEnabled: z.boolean().default(true),
  embeddingModel: z.string().default("nomic-embed-text"),
  embeddingProvider: z.enum(["ollama", "huggingface"]).default("ollama"),
  alpha: z.number().min(0).max(1).default(0.5),
  ollamaUrl: z.string().default("http://localhost:11434"),
});

const OrchestrationConfigSchema = z.object({
  autoAdvance: z.boolean().default(false),
  pollIntervalMs: z.number().min(1000).default(30000),
  maxConcurrentAgents: z.number().min(1).default(5),
});

const DashboardConfigSchema = z.object({
  authToken: z.string().optional(),
});

const ServerConfigSchema = z.object({
  port: z.number().default(3000),
  host: z.string().default("localhost"),
});

export const MonstheraConfigSchema = z.object({
  repoPath: z.string(),
  storage: StorageConfigSchema.default(() => StorageConfigSchema.parse({})),
  search: SearchConfigSchema.default(() => SearchConfigSchema.parse({})),
  orchestration: OrchestrationConfigSchema.default(() => OrchestrationConfigSchema.parse({})),
  server: ServerConfigSchema.default(() => ServerConfigSchema.parse({})),
  dashboard: DashboardConfigSchema.default(() => DashboardConfigSchema.parse({})),
  verbosity: z.enum(["quiet", "normal", "verbose", "debug"]).default("normal"),
});

export type MonstheraConfig = z.infer<typeof MonstheraConfigSchema>;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a default config for a given repo path.
 */
export function defaultConfig(repoPath: string): MonstheraConfig {
  const result = MonstheraConfigSchema.safeParse({ repoPath });
  if (!result.success) {
    // This should never happen with a valid repoPath string
    throw new Error(`Failed to create default config: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Validate and parse raw config object.
 */
export function validateConfig(raw: unknown): Result<MonstheraConfig, ConfigurationError> {
  const result = MonstheraConfigSchema.safeParse(raw);
  if (!result.success) {
    return err(
      new ConfigurationError("Invalid configuration", {
        issues: result.error.issues,
      }),
    );
  }
  return ok(result.data);
}

/**
 * Merge environment variable overrides into raw config.
 * Env vars: MONSTHERA_VERBOSITY, MONSTHERA_PORT, MONSTHERA_DOLT_ENABLED, etc.
 */
export function applyEnvOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const result = { ...config };

  // Top-level overrides
  if (process.env["MONSTHERA_VERBOSITY"] !== undefined) {
    result["verbosity"] = process.env["MONSTHERA_VERBOSITY"];
  }

  // Server overrides
  if (process.env["MONSTHERA_PORT"] !== undefined) {
    const port = Number(process.env["MONSTHERA_PORT"]);
    if (!Number.isNaN(port)) {
      result["server"] = {
        ...(typeof result["server"] === "object" && result["server"] !== null
          ? (result["server"] as Record<string, unknown>)
          : {}),
        port,
      };
    }
  }

  if (process.env["MONSTHERA_HOST"] !== undefined) {
    result["server"] = {
      ...(typeof result["server"] === "object" && result["server"] !== null
        ? (result["server"] as Record<string, unknown>)
        : {}),
      host: process.env["MONSTHERA_HOST"],
    };
  }

  // Storage overrides
  if (process.env["MONSTHERA_DOLT_ENABLED"] !== undefined) {
    result["storage"] = {
      ...(typeof result["storage"] === "object" && result["storage"] !== null
        ? (result["storage"] as Record<string, unknown>)
        : {}),
      doltEnabled: process.env["MONSTHERA_DOLT_ENABLED"] === "true",
    };
  }

  if (process.env["MONSTHERA_MARKDOWN_ROOT"] !== undefined) {
    result["storage"] = {
      ...(typeof result["storage"] === "object" && result["storage"] !== null
        ? (result["storage"] as Record<string, unknown>)
        : {}),
      markdownRoot: process.env["MONSTHERA_MARKDOWN_ROOT"],
    };
  }

  if (process.env["MONSTHERA_DOLT_HOST"] !== undefined) {
    result["storage"] = {
      ...(typeof result["storage"] === "object" && result["storage"] !== null
        ? (result["storage"] as Record<string, unknown>)
        : {}),
      doltHost: process.env["MONSTHERA_DOLT_HOST"],
    };
  }

  if (process.env["MONSTHERA_DOLT_PORT"] !== undefined) {
    const port = Number(process.env["MONSTHERA_DOLT_PORT"]);
    if (!Number.isNaN(port)) {
      result["storage"] = {
        ...(typeof result["storage"] === "object" && result["storage"] !== null
          ? (result["storage"] as Record<string, unknown>)
          : {}),
        doltPort: port,
      };
    }
  }

  if (process.env["MONSTHERA_DOLT_DATABASE"] !== undefined) {
    result["storage"] = {
      ...(typeof result["storage"] === "object" && result["storage"] !== null
        ? (result["storage"] as Record<string, unknown>)
        : {}),
      doltDatabase: process.env["MONSTHERA_DOLT_DATABASE"],
    };
  }

  if (process.env["MONSTHERA_DOLT_USER"] !== undefined) {
    result["storage"] = {
      ...(typeof result["storage"] === "object" && result["storage"] !== null
        ? (result["storage"] as Record<string, unknown>)
        : {}),
      doltUser: process.env["MONSTHERA_DOLT_USER"],
    };
  }

  if (process.env["MONSTHERA_DOLT_PASSWORD"] !== undefined) {
    result["storage"] = {
      ...(typeof result["storage"] === "object" && result["storage"] !== null
        ? (result["storage"] as Record<string, unknown>)
        : {}),
      doltPassword: process.env["MONSTHERA_DOLT_PASSWORD"],
    };
  }

  // Dashboard overrides
  if (process.env["MONSTHERA_DASHBOARD_TOKEN"] !== undefined) {
    result["dashboard"] = {
      ...(typeof result["dashboard"] === "object" && result["dashboard"] !== null
        ? (result["dashboard"] as Record<string, unknown>)
        : {}),
      authToken: process.env["MONSTHERA_DASHBOARD_TOKEN"],
    };
  }

  // Search overrides
  if (process.env["MONSTHERA_SEMANTIC_ENABLED"] !== undefined) {
    result["search"] = {
      ...(typeof result["search"] === "object" && result["search"] !== null
        ? (result["search"] as Record<string, unknown>)
        : {}),
      semanticEnabled: process.env["MONSTHERA_SEMANTIC_ENABLED"] === "true",
    };
  }

  if (process.env["MONSTHERA_EMBEDDING_MODEL"] !== undefined) {
    result["search"] = {
      ...(typeof result["search"] === "object" && result["search"] !== null
        ? (result["search"] as Record<string, unknown>)
        : {}),
      embeddingModel: process.env["MONSTHERA_EMBEDDING_MODEL"],
    };
  }

  if (process.env["MONSTHERA_OLLAMA_URL"] !== undefined) {
    result["search"] = {
      ...(typeof result["search"] === "object" && result["search"] !== null
        ? (result["search"] as Record<string, unknown>)
        : {}),
      ollamaUrl: process.env["MONSTHERA_OLLAMA_URL"],
    };
  }

  return result;
}

/**
 * Load config from file, merge env overrides, validate.
 * Returns Result — never throws.
 */
export function loadConfig(repoPath: string): Result<MonstheraConfig, ConfigurationError> {
  const configPath = path.join(repoPath, DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILE);

  let raw: Record<string, unknown> = { repoPath };

  if (fs.existsSync(configPath)) {
    let fileContent: string;
    try {
      fileContent = fs.readFileSync(configPath, "utf-8");
    } catch (e) {
      return err(
        new ConfigurationError(`Failed to read config file: ${configPath}`, {
          cause: String(e),
        }),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(fileContent);
    } catch (e) {
      return err(
        new ConfigurationError(`Malformed JSON in config file: ${configPath}`, {
          cause: String(e),
        }),
      );
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return err(
        new ConfigurationError(`Config file must be a JSON object: ${configPath}`, {}),
      );
    }

    raw = { ...(parsed as Record<string, unknown>), repoPath };
  }

  const withEnv = applyEnvOverrides(raw);
  return validateConfig(withEnv);
}
