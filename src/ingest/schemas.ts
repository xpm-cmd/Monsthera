import { z } from "zod/v4";
import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import { ValidationError } from "../core/errors.js";

export const INGEST_MODES = ["raw", "summary"] as const;

export const IngestLocalInputSchema = z.object({
  sourcePath: z.string().min(1),
  category: z.string().min(1).max(100).optional(),
  tags: z.array(z.string()).default([]),
  codeRefs: z.array(z.string()).default([]),
  mode: z.enum(INGEST_MODES).default("raw"),
  recursive: z.boolean().default(true),
  replaceExisting: z.boolean().default(true),
  // When true, skip auto-appending the "imported" tag. Default false
  // preserves the pre-alpha.7 behaviour so every existing caller keeps
  // its tag set — this is an opt-out, not a breaking change.
  noImportedTag: z.boolean().default(false),
});

export type IngestLocalInput = z.infer<typeof IngestLocalInputSchema>;
export type IngestMode = IngestLocalInput["mode"];

export function validateIngestLocalInput(raw: unknown): Result<IngestLocalInput, ValidationError> {
  const result = IngestLocalInputSchema.safeParse(raw);
  if (!result.success) {
    return err(new ValidationError("Invalid ingest input", { issues: result.error.issues }));
  }
  return ok(result.data);
}

// ─── Git/PR ingestion (PR-15) ──────────────────────────────────────────────

/** Ingest the commits in a git revision range (e.g. `HEAD~5..HEAD`, `main..feat`). */
export const IngestGitInputSchema = z.object({
  range: z.string().min(1),
  category: z.string().min(1).max(100).optional(),
  tags: z.array(z.string()).default([]),
  replaceExisting: z.boolean().default(true),
});

/** Ingest the commits of a merged GitHub pull request, resolved via its merge commit. */
export const IngestPrInputSchema = z.object({
  prNumber: z.number().int().positive(),
  category: z.string().min(1).max(100).optional(),
  tags: z.array(z.string()).default([]),
  replaceExisting: z.boolean().default(true),
});

export type IngestGitInput = z.infer<typeof IngestGitInputSchema>;
export type IngestPrInput = z.infer<typeof IngestPrInputSchema>;

export function validateIngestGitInput(raw: unknown): Result<IngestGitInput, ValidationError> {
  const result = IngestGitInputSchema.safeParse(raw);
  if (!result.success) {
    return err(new ValidationError("Invalid git ingest input", { issues: result.error.issues }));
  }
  return ok(result.data);
}

export function validateIngestPrInput(raw: unknown): Result<IngestPrInput, ValidationError> {
  const result = IngestPrInputSchema.safeParse(raw);
  if (!result.success) {
    return err(new ValidationError("Invalid PR ingest input", { issues: result.error.issues }));
  }
  return ok(result.data);
}
