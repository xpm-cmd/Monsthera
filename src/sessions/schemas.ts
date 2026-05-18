import { z } from "zod/v4";
import type { Result } from "../core/result.js";
import { ok, err } from "../core/result.js";
import { ValidationError } from "../core/errors.js";

// ─── Session status ──────────────────────────────────────────────────────────

export const SessionStatus = {
  OPEN: "open",
  CLOSED: "closed",
  ABANDONED: "abandoned",
} as const;

export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus];

export const VALID_SESSION_STATUSES: ReadonlySet<string> = new Set<string>(
  Object.values(SessionStatus),
);

// ─── Abandonment reasons ──────────────────────────────────────────────────────

export const AbandonmentReason = {
  SUPERSEDED: "superseded",
  MANUAL: "manual",
  IDLE: "idle",
  WORKER_LOST: "worker_lost",
} as const;

export type AbandonmentReason = (typeof AbandonmentReason)[keyof typeof AbandonmentReason];

// ─── Quality model ────────────────────────────────────────────────────────────

/**
 * `writer` identifies which producer authored the handoff body. Added in
 * ADR-019 alongside the agent-direct handoff path. Defaults to `"ollama"`
 * for backward compatibility with session records persisted before the
 * field existed (they predate any agent-direct rendering).
 *
 * - `"ollama"`  — Stage B/C/D ran a local LLM (gemma4, qwen-coder, etc.).
 *                `model` carries the specific model name (e.g. "gemma4:latest").
 * - `"agent"`   — the executing agent wrote the body directly via
 *                `session close --content[-file]`. `model` carries the
 *                `agentId` (e.g. "claude-code", "codex-cli"). `score` is
 *                null (no self-eval); `degraded` is false.
 */
export const SessionWriter = {
  OLLAMA: "ollama",
  AGENT: "agent",
} as const;
export type SessionWriter = (typeof SessionWriter)[keyof typeof SessionWriter];

export const SessionQualitySchema = z.object({
  score: z.number().int().min(1).max(5).nullable(),
  degraded: z.boolean(),
  model: z.string().nullable(),
  /** ADR-019: identifies who wrote the handoff. Backward compat: defaults to "ollama". */
  writer: z.enum(["ollama", "agent"]).default("ollama"),
});

export type SessionQuality = z.infer<typeof SessionQualitySchema>;

// ─── Session frontmatter (persisted) ──────────────────────────────────────────
//
// The repository persists Sessions as JSON-or-flat-frontmatter on disk.
// `quality` is a nested object in the in-memory representation; the
// file-repository flattens it to `qualityScore`/`qualityDegraded`/`qualityModel`
// when serializing to the naive YAML format used by `knowledge/markdown.ts`,
// and re-nests on read.

export const SessionFrontmatterSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().nullable(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
  status: z.enum([SessionStatus.OPEN, SessionStatus.CLOSED, SessionStatus.ABANDONED]),
  handoffArticleId: z.string().nullable(),
  factsPath: z.string().nullable(),
  parentSessionId: z.string().nullable(),
  abandonReason: z.string().nullable(),
  quality: SessionQualitySchema,
  intent: z.string().nullable(),
});

export type SessionFrontmatter = z.infer<typeof SessionFrontmatterSchema>;

// ─── Create input ─────────────────────────────────────────────────────────────

export const CreateSessionInputSchema = z.object({
  agentId: z.string().min(1),
  repo: z.string().min(1),
  branch: z.string().nullable().optional(),
  intent: z.string().min(1).max(500).nullable().optional(),
  parentSessionId: z.string().nullable().optional(),
  openedAt: z.string().optional(),
});

export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

// ─── Close input ──────────────────────────────────────────────────────────────

export const CloseSessionInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  note: z.string().max(500).nullable().optional(),
  noLlm: z.boolean().optional(),
  closedAt: z.string().optional(),
});

export type CloseSessionInput = z.infer<typeof CloseSessionInputSchema>;

// ─── List filter ──────────────────────────────────────────────────────────────

export const ListSessionsFilterSchema = z.object({
  agentId: z.string().optional(),
  repo: z.string().optional(),
  status: z.enum([SessionStatus.OPEN, SessionStatus.CLOSED, SessionStatus.ABANDONED]).optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

export type ListSessionsFilter = z.infer<typeof ListSessionsFilterSchema>;

// ─── Session facts (Stage A output, persisted as JSON next to the Session) ────

export const SessionFactsEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  workId: z.string().optional(),
  agentId: z.string().optional(),
  timestamp: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const SessionFactsWorkTouchedSchema = z.object({
  id: z.string(),
  title: z.string(),
  phaseAtOpen: z.string(),
  phaseAtClose: z.string(),
  role: z.string(),
});

export const SessionFactsKnowledgeTouchedSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  category: z.string(),
  op: z.enum(["created", "updated"]),
});

export const SessionFactsCodeTouchedSchema = z.object({
  path: z.string(),
  linesAdded: z.number().int().min(0),
  linesRemoved: z.number().int().min(0),
  impactScore: z.number().optional(),
  owners: z.array(z.string()).optional(),
});

export const SessionFactsCommitSchema = z.object({
  sha: z.string(),
  subject: z.string(),
  timestamp: z.string(),
});

export const SessionFactsSignalsSchema = z.object({
  todosAdded: z.array(z.object({ path: z.string(), line: z.number().int(), text: z.string() })),
  questions: z.array(z.object({ path: z.string(), line: z.number().int(), text: z.string() })),
  testFailures: z.array(z.object({ event: z.string(), details: z.string() })),
});

export const SessionFactsSchema = z.object({
  sessionId: z.string(),
  agent: z.string(),
  repo: z.string(),
  branch: z.string().nullable(),
  window: z.object({
    openedAt: z.string(),
    closedAt: z.string(),
  }),
  events: z.array(SessionFactsEventSchema),
  workTouched: z.array(SessionFactsWorkTouchedSchema),
  knowledgeTouched: z.array(SessionFactsKnowledgeTouchedSchema),
  codeTouched: z.array(SessionFactsCodeTouchedSchema),
  commits: z.array(SessionFactsCommitSchema),
  signals: SessionFactsSignalsSchema,
  agentNote: z.string().nullable(),
});

export type SessionFactsEvent = z.infer<typeof SessionFactsEventSchema>;
export type SessionFactsWorkTouched = z.infer<typeof SessionFactsWorkTouchedSchema>;
export type SessionFactsKnowledgeTouched = z.infer<typeof SessionFactsKnowledgeTouchedSchema>;
export type SessionFactsCodeTouched = z.infer<typeof SessionFactsCodeTouchedSchema>;
export type SessionFactsCommit = z.infer<typeof SessionFactsCommitSchema>;
export type SessionFactsSignals = z.infer<typeof SessionFactsSignalsSchema>;
export type SessionFacts = z.infer<typeof SessionFactsSchema>;

// ─── Validators ───────────────────────────────────────────────────────────────

export function validateCreateSessionInput(
  raw: unknown,
): Result<CreateSessionInput, ValidationError> {
  const result = CreateSessionInputSchema.safeParse(raw);
  if (!result.success) {
    return err(new ValidationError("Invalid create session input", { issues: result.error.issues }));
  }
  return ok(result.data);
}

export function validateCloseSessionInput(
  raw: unknown,
): Result<CloseSessionInput, ValidationError> {
  const result = CloseSessionInputSchema.safeParse(raw);
  if (!result.success) {
    return err(new ValidationError("Invalid close session input", { issues: result.error.issues }));
  }
  return ok(result.data);
}

export function validateSessionFrontmatter(
  raw: unknown,
): Result<SessionFrontmatter, ValidationError> {
  const result = SessionFrontmatterSchema.safeParse(raw);
  if (!result.success) {
    return err(new ValidationError("Invalid session frontmatter", { issues: result.error.issues }));
  }
  return ok(result.data);
}

export function validateSessionFacts(raw: unknown): Result<SessionFacts, ValidationError> {
  const result = SessionFactsSchema.safeParse(raw);
  if (!result.success) {
    return err(new ValidationError("Invalid session facts", { issues: result.error.issues }));
  }
  return ok(result.data);
}
