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
  embeddingProvider: z.enum(["ollama"]).default("ollama"),
  alpha: z.number().min(0).max(1).default(0.5),
  ollamaUrl: z.string().default("http://localhost:11434"),
  // ── Ranking knobs (PR-10). Every field is defaulted to the value that was
  // previously hardcoded, so an unset config reproduces today's ranking
  // exactly (the PR-7 characterization pins stay green). Override via
  // MONSTHERA_SEARCH_* env vars; measure changes with `monsthera eval`.
  bm25K1: z.number().min(0).default(1.2),
  titleBoost: z.number().min(0).default(3.0),
  freshnessFreshDays: z.number().min(0).default(14),
  freshnessStaleDays: z.number().min(0).default(45),
  rerankEnabled: z.boolean().default(false),
  rankProfile: z.enum(["conservative", "balanced", "tokenmax"]).default("balanced"),
});

const OrchestrationConfigSchema = z.object({
  autoAdvance: z.boolean().default(false),
  pollIntervalMs: z.number().min(1000).default(30000),
  maxConcurrentAgents: z.number().min(1).default(5),
});

const DashboardConfigSchema = z.object({
  authToken: z.string().optional(),
});

const ContextConfigSchema = z.object({
  /** Snapshots older than this are flagged `stale` in context packs. 0 disables the check. */
  snapshotMaxAgeMinutes: z.number().min(0).default(30),
});

const SessionsConfigSchema = z.object({
  /** Enable LLM-powered handoff articles. When false, all closes produce T1-only handoffs. */
  llmEnabled: z.boolean().default(true),
  /** Ollama model for the retrospect+prospect summarizer. */
  llmModel: z.string().default("gemma4:latest"),
  /** Temperature for the summarizer. Lower = more deterministic. */
  llmTemperature: z.number().min(0).max(1).default(0.2),
  /** Timeout for a single Ollama generate call (ms). */
  llmTimeoutMs: z.number().min(1000).default(60_000),
});

/**
 * General-purpose text generator (think synthesis + work→knowledge
 * distillation). Distinct from `sessions.*` (which is the session-summarizer
 * specialization). Default disabled ⇒ a stub is used and those features
 * degrade gracefully. `apiKey` is intentionally absent — it is a secret read
 * only from MONSTHERA_LLM_API_KEY / OPENAI_API_KEY at container build time.
 */
const LlmConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["ollama", "openai"]).default("ollama"),
  model: z.string().default("gemma4:latest"),
  temperature: z.number().min(0).max(1).default(0.2),
  timeoutMs: z.number().min(1000).default(60_000),
  /** Base URL for the `openai` provider (OpenAI, Azure, OpenRouter, vLLM, LM Studio…). Ignored for `ollama`, which reuses `search.ollamaUrl`. */
  baseUrl: z.string().default("https://api.openai.com/v1"),
});

/**
 * Hosts that bind only to the local machine. Anything else (notably 0.0.0.0)
 * exposes the dashboard on every network interface.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Whether the operator has explicitly opted in to a non-loopback bind. Read
 * from the environment so the guard covers every config source — env override
 * (MONSTHERA_HOST) and config.json alike — at the single schema chokepoint.
 */
function nonLocalHostAllowed(): boolean {
  return process.env["MONSTHERA_ALLOW_NONLOCAL_HOST"] === "true";
}

const ServerConfigSchema = z
  .object({
    port: z.number().default(3000),
    host: z.string().default("localhost"),
  })
  .superRefine((cfg, ctx) => {
    // A non-loopback host opens the dashboard to the network. Reject it unless
    // the operator opted in with MONSTHERA_ALLOW_NONLOCAL_HOST=true.
    if (!LOOPBACK_HOSTS.has(cfg.host) && !nonLocalHostAllowed()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["host"],
        message:
          `Refusing to bind dashboard to non-loopback host "${cfg.host}": this exposes it on ` +
          `all network interfaces. Set MONSTHERA_ALLOW_NONLOCAL_HOST=true to opt in, or use a ` +
          `loopback host (localhost / 127.0.0.1 / ::1).`,
      });
    }
  });

export const MonstheraConfigSchema = z.object({
  repoPath: z.string(),
  storage: StorageConfigSchema.default(() => StorageConfigSchema.parse({})),
  search: SearchConfigSchema.default(() => SearchConfigSchema.parse({})),
  orchestration: OrchestrationConfigSchema.default(() => OrchestrationConfigSchema.parse({})),
  server: ServerConfigSchema.default(() => ServerConfigSchema.parse({})),
  dashboard: DashboardConfigSchema.default(() => DashboardConfigSchema.parse({})),
  context: ContextConfigSchema.default(() => ContextConfigSchema.parse({})),
  sessions: SessionsConfigSchema.default(() => SessionsConfigSchema.parse({})),
  llm: LlmConfigSchema.default(() => LlmConfigSchema.parse({})),
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

  // Ranking knobs (PR-10). Numeric vars are skipped silently when unparseable
  // so a typo never crashes config load — the schema default applies instead.
  for (const [envVar, field] of [
    ["MONSTHERA_SEARCH_BM25K1", "bm25K1"],
    ["MONSTHERA_SEARCH_TITLE_BOOST", "titleBoost"],
    ["MONSTHERA_SEARCH_FRESHNESS_FRESH_DAYS", "freshnessFreshDays"],
    ["MONSTHERA_SEARCH_FRESHNESS_STALE_DAYS", "freshnessStaleDays"],
  ] as const) {
    const raw = process.env[envVar];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    result["search"] = {
      ...(typeof result["search"] === "object" && result["search"] !== null
        ? (result["search"] as Record<string, unknown>)
        : {}),
      [field]: value,
    };
  }

  if (process.env["MONSTHERA_SEARCH_RERANK_ENABLED"] !== undefined) {
    result["search"] = {
      ...(typeof result["search"] === "object" && result["search"] !== null
        ? (result["search"] as Record<string, unknown>)
        : {}),
      rerankEnabled: process.env["MONSTHERA_SEARCH_RERANK_ENABLED"] === "true",
    };
  }

  if (process.env["MONSTHERA_SEARCH_RANK_PROFILE"] !== undefined) {
    result["search"] = {
      ...(typeof result["search"] === "object" && result["search"] !== null
        ? (result["search"] as Record<string, unknown>)
        : {}),
      rankProfile: process.env["MONSTHERA_SEARCH_RANK_PROFILE"],
    };
  }

  if (process.env["MONSTHERA_SNAPSHOT_MAX_AGE_MINUTES"] !== undefined) {
    const minutes = Number(process.env["MONSTHERA_SNAPSHOT_MAX_AGE_MINUTES"]);
    if (Number.isFinite(minutes) && minutes >= 0) {
      result["context"] = {
        ...(typeof result["context"] === "object" && result["context"] !== null
          ? (result["context"] as Record<string, unknown>)
          : {}),
        snapshotMaxAgeMinutes: minutes,
      };
    }
  }

  // Sessions overrides
  const sessionsPatch: Record<string, unknown> = {};
  if (process.env["MONSTHERA_SESSIONS_LLM_ENABLED"] !== undefined) {
    sessionsPatch["llmEnabled"] = process.env["MONSTHERA_SESSIONS_LLM_ENABLED"] === "true";
  }
  if (process.env["MONSTHERA_SESSIONS_LLM_MODEL"] !== undefined) {
    sessionsPatch["llmModel"] = process.env["MONSTHERA_SESSIONS_LLM_MODEL"];
  }
  if (process.env["MONSTHERA_SESSIONS_LLM_TIMEOUT_MS"] !== undefined) {
    const ms = Number(process.env["MONSTHERA_SESSIONS_LLM_TIMEOUT_MS"]);
    if (Number.isFinite(ms) && ms > 0) sessionsPatch["llmTimeoutMs"] = ms;
  }
  if (Object.keys(sessionsPatch).length > 0) {
    result["sessions"] = {
      ...(typeof result["sessions"] === "object" && result["sessions"] !== null
        ? (result["sessions"] as Record<string, unknown>)
        : {}),
      ...sessionsPatch,
    };
  }

  // LLM (general text generator) overrides. apiKey is read at container build
  // time, not here — it must never land in the validated config object.
  const llmPatch: Record<string, unknown> = {};
  if (process.env["MONSTHERA_LLM_ENABLED"] !== undefined) {
    llmPatch["enabled"] = process.env["MONSTHERA_LLM_ENABLED"] === "true";
  }
  if (process.env["MONSTHERA_LLM_PROVIDER"] !== undefined) {
    llmPatch["provider"] = process.env["MONSTHERA_LLM_PROVIDER"];
  }
  if (process.env["MONSTHERA_LLM_MODEL"] !== undefined) {
    llmPatch["model"] = process.env["MONSTHERA_LLM_MODEL"];
  }
  if (process.env["MONSTHERA_LLM_BASE_URL"] !== undefined) {
    llmPatch["baseUrl"] = process.env["MONSTHERA_LLM_BASE_URL"];
  }
  if (process.env["MONSTHERA_LLM_TIMEOUT_MS"] !== undefined) {
    const ms = Number(process.env["MONSTHERA_LLM_TIMEOUT_MS"]);
    if (Number.isFinite(ms) && ms > 0) llmPatch["timeoutMs"] = ms;
  }
  if (Object.keys(llmPatch).length > 0) {
    result["llm"] = {
      ...(typeof result["llm"] === "object" && result["llm"] !== null
        ? (result["llm"] as Record<string, unknown>)
        : {}),
      ...llmPatch,
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
