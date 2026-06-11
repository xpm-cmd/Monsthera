import { z } from "zod/v4";
import type { Result } from "../core/result.js";
import { ok, err } from "../core/result.js";
import { ValidationError } from "../core/errors.js";
import { normalizeTags } from "./tags.js";

// ─── Canonical category constants ────────────────────────────────────────────
//
// Categories are free-form strings (`category: z.string().min(1).max(100)` below),
// but well-known values used in business logic should be referenced via these
// constants to avoid magic strings drifting across the codebase.
export const POLICY_CATEGORY = "policy" as const;

// ─── Schemas ─────────────────────────────────────────────────────────────────

/** Schema for article frontmatter (parsed from YAML/markdown front matter) */
export const ArticleFrontmatterSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  slug: z.string(),
  category: z.string().min(1).max(100),
  tags: z.array(z.string()).default([]),
  codeRefs: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
  sourcePath: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Pattern for URL-safe slugs: lowercase alphanumerics and hyphens only. */
export const SLUG_PATTERN = /^[a-z0-9-]+$/;

/**
 * Schema for create input (from MCP tool / service caller).
 *
 * H4: strict — an unknown key is a loud ValidationError, never a silent
 * strip. Same rationale as the ADR-020 note below: a typo must surface,
 * not vanish. System-owned fields (`id`, `createdAt`, `updatedAt`) are
 * deliberately absent: they exist on the repo input for ingestion paths
 * that call the repository directly, and rejecting them here keeps agents
 * from forging identity or history through the service surface.
 */
export const CreateArticleInputSchema = z.strictObject({
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  content: z.string().min(1),
  tags: z.array(z.string()).transform(normalizeTags).default([]),
  codeRefs: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(SLUG_PATTERN, "slug must match ^[a-z0-9-]+$ (lowercase alphanumerics and hyphens only)")
    .optional(),
  // Provenance pointer to the source file an article was imported from.
  // The repo always honored it; H4 exposes it through the service.
  sourcePath: z.string().min(1).optional(),
  // ADR-020: typed/custom frontmatter. Unknown keys are NOT auto-routed (that
  // would mask typos in the fields above); callers pass an explicit object,
  // which the repo persists and round-trips verbatim.
  extraFrontmatter: z.record(z.string(), z.unknown()).optional(),
});

/** Schema for update input — all fields optional. Strict (see create schema). */
export const UpdateArticleInputSchema = z
  .strictObject({
    title: z.string().min(1).max(200).optional(),
    category: z.string().min(1).max(100).optional(),
    content: z.string().min(1).optional(),
    tags: z.array(z.string()).transform(normalizeTags).optional(),
    // Incremental tag ops, resolved by the service against the article's
    // current tags (H4: previously only the single-update MCP handler knew
    // them, so batch updates dropped them silently).
    add_tags: z.array(z.string()).optional(),
    remove_tags: z.array(z.string()).optional(),
    codeRefs: z.array(z.string()).optional(),
    references: z.array(z.string()).optional(),
    new_slug: z
      .string()
      .min(1)
      .max(200)
      .regex(SLUG_PATTERN, "new_slug must match ^[a-z0-9-]+$ (lowercase alphanumerics and hyphens only)")
      .optional(),
    rewrite_inline_wikilinks: z.boolean().optional(),
    sourcePath: z.string().min(1).optional(),
    // ADR-020: replaces the prior custom-frontmatter map when supplied (see repo update).
    extraFrontmatter: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (v) => v.tags === undefined || (v.add_tags === undefined && v.remove_tags === undefined),
    { message: "Use `tags` (full replace) or `add_tags`/`remove_tags` (incremental), not both." },
  );

// ─── Inferred types ───────────────────────────────────────────────────────────

export type ArticleFrontmatter = z.infer<typeof ArticleFrontmatterSchema>;
export type CreateArticleInput = z.infer<typeof CreateArticleInputSchema>;
export type UpdateArticleInput = z.infer<typeof UpdateArticleInputSchema>;

// ─── Validation functions ─────────────────────────────────────────────────────

/** Validate raw create input and return a typed Result. */
export function validateCreateInput(raw: unknown): Result<CreateArticleInput, ValidationError> {
  const result = CreateArticleInputSchema.safeParse(raw);
  if (!result.success) {
    return err(
      new ValidationError("Invalid create article input", {
        issues: result.error.issues,
      }),
    );
  }
  return ok(result.data);
}

/** Validate raw update input and return a typed Result. */
export function validateUpdateInput(raw: unknown): Result<UpdateArticleInput, ValidationError> {
  const result = UpdateArticleInputSchema.safeParse(raw);
  if (!result.success) {
    return err(
      new ValidationError("Invalid update article input", {
        issues: result.error.issues,
      }),
    );
  }
  return ok(result.data);
}

/** Validate raw frontmatter (parsed from YAML) and return a typed Result. */
export function validateFrontmatter(raw: unknown): Result<ArticleFrontmatter, ValidationError> {
  const result = ArticleFrontmatterSchema.safeParse(raw);
  if (!result.success) {
    return err(
      new ValidationError("Invalid article frontmatter", {
        issues: result.error.issues,
      }),
    );
  }
  return ok(result.data);
}
