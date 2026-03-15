// Version injected by tsup define at build time; fallback for dev (tsx)
export const VERSION: string = typeof __AGORA_VERSION__ !== "undefined"
  ? __AGORA_VERSION__
  : "1.0.0-dev";

declare const __AGORA_VERSION__: string;
export const DEFAULT_DASHBOARD_PORT = 3141;
export const DEFAULT_AGORA_DIR = ".agora";
export const DEFAULT_DB_NAME = "agora.db";

// Evidence Bundle limits
export const STAGE_A_MAX_CANDIDATES = 10;
export const STAGE_B_MAX_EXPANDED = 5;
export const MAX_CODE_SPAN_LINES = 200;
export const MAX_DIFF_LINES_PER_FILE = 50; // Truncate per-file diffs in get_change_pack

// Trust
export const DEFAULT_TRUST_TIER = "B" as const;

// Sessions
export const HEARTBEAT_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours
export const CLAIM_RELEASE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Logging
export const DEBUG_PAYLOAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const REDACTED_SUMMARY_MAX_LENGTH = 200;
export const REDACTED_ERROR_DETAIL_MAX_LENGTH = 240;

// Indexing
export const LARGE_FILE_THRESHOLD_LINES = 10_000;

// Supported languages for symbol extraction
export const SUPPORTED_LANGUAGES = ["typescript", "javascript", "python", "go", "rust"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

// Embedding dimension — matches the embedding model's native output dimension.
// Xenova/all-MiniLM-L6-v2 produces 384-dim. Override via env for other models.
export const EMBEDDING_DIMENSION = parseInt(process.env.AGORA_EMBEDDING_DIM ?? "384", 10);
