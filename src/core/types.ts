/** Branded type helper — prevents mixing different ID types */
type Brand<T, B extends string> = T & { readonly __brand: B };

/** Unique identifier for knowledge articles */
export type ArticleId = Brand<string, "ArticleId">;

/** Unique identifier for work articles */
export type WorkId = Brand<string, "WorkId">;

/** Unique identifier for agents */
export type AgentId = Brand<string, "AgentId">;

/** Unique identifier for sessions */
export type SessionId = Brand<string, "SessionId">;

/** Unique identifier for convoys (orchestration grouping of work articles) */
export type ConvoyId = Brand<string, "ConvoyId">;

/** URL-safe slug for articles */
export type Slug = Brand<string, "Slug">;

/** ISO 8601 timestamp string */
export type Timestamp = Brand<string, "Timestamp">;

/** Factory functions for branded types */
export function articleId(id: string): ArticleId {
  return id as ArticleId;
}

export function workId(id: string): WorkId {
  return id as WorkId;
}

export function agentId(id: string): AgentId {
  return id as AgentId;
}

export function sessionId(id: string): SessionId {
  return id as SessionId;
}

export function convoyId(id: string): ConvoyId {
  return id as ConvoyId;
}

export function slug(value: string): Slug {
  return value as Slug;
}

export function timestamp(iso?: string): Timestamp {
  return (iso ?? new Date().toISOString()) as Timestamp;
}

/** Generate a random ID with a prefix */
export function generateId(prefix: string): string {
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}-${random}`;
}

/** Generate a work article ID */
export function generateWorkId(): WorkId {
  return workId(generateId("w"));
}

/** Generate an article ID */
export function generateArticleId(): ArticleId {
  return articleId(generateId("k"));
}

/** Generate a convoy ID */
export function generateConvoyId(): ConvoyId {
  return convoyId(generateId("cv"));
}

/**
 * Generate a Session ID with a stable, sortable, human-readable shape:
 *   `ses-<UTC-YYYYMMDD-HHMMSS>-<agentId>`
 *
 * The second-resolution timestamp prevents collisions when an agent closes
 * and immediately re-opens within the same minute (typical for back-to-back
 * Claude/Codex conversations). The agent suffix makes cross-agent sessions
 * distinguishable at a glance, and the lexicographically-sortable timestamp
 * makes filesystem listings naturally chronological. Agent slug is sanitized:
 * lowercased, non-[a-z0-9-] replaced with `-`.
 */
export function generateSessionId(agentId: string, when: Date = new Date()): SessionId {
  const pad = (n: number): string => n.toString().padStart(2, "0");
  const stamp =
    `${when.getUTCFullYear()}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}` +
    `-${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}${pad(when.getUTCSeconds())}`;
  const agentSlug = agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return sessionId(`ses-${stamp}-${agentSlug || "unknown"}`);
}

/** Work article phases */
export const WorkPhase = {
  PLANNING: "planning",
  ENRICHMENT: "enrichment",
  IMPLEMENTATION: "implementation",
  REVIEW: "review",
  DONE: "done",
  CANCELLED: "cancelled",
} as const;

export type WorkPhase = (typeof WorkPhase)[keyof typeof WorkPhase];

/** Set of all valid WorkPhase values (for input validation) */
export const VALID_PHASES: ReadonlySet<string> = new Set<string>(Object.values(WorkPhase));

/** Work article priority */
export const Priority = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const;

export type Priority = (typeof Priority)[keyof typeof Priority];

/** Work article templates */
export const WorkTemplate = {
  FEATURE: "feature",
  BUGFIX: "bugfix",
  REFACTOR: "refactor",
  SPIKE: "spike",
} as const;

export type WorkTemplate = (typeof WorkTemplate)[keyof typeof WorkTemplate];

/** Enrichment role types */
export const EnrichmentRole = {
  ARCHITECTURE: "architecture",
  SECURITY: "security",
  PERFORMANCE: "performance",
  TESTING: "testing",
  DOCUMENTATION: "documentation",
  UX: "ux",
  DATA: "data",
  DOMAIN: "domain",
} as const;

export type EnrichmentRole = (typeof EnrichmentRole)[keyof typeof EnrichmentRole];

/** Review status */
export const ReviewStatus = {
  PENDING: "pending",
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
} as const;

export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

/** Enrichment contribution status */
export const ContributionStatus = {
  PENDING: "pending",
  CONTRIBUTED: "contributed",
  SKIPPED: "skipped",
} as const;

export type ContributionStatus = (typeof ContributionStatus)[keyof typeof ContributionStatus];
