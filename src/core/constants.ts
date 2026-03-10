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
export const MIN_RELEVANCE_SCORE = 0.35; // Filter low-confidence results (nonsense guard)
export const MIN_RELEVANCE_SCORE_SCOPED = 0.20; // Lower threshold for scoped queries (raised from 0.15 to reduce false positives)
export const MAX_DIFF_LINES_PER_FILE = 50; // Truncate per-file diffs in get_change_pack

// Trust
export const DEFAULT_TRUST_TIER = "B" as const;

// Sessions
export const HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
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
