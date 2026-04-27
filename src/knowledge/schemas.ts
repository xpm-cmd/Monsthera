import { z } from "zod/v4";
import type { Result } from "../core/result.js";
import { ok, err } from "../core/result.js";
import { ValidationError } from "../core/errors.js";

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

/** Schema for create input (from MCP tool / service caller) */
export const CreateArticleInputSchema = z.object({
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
  codeRefs: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
  slug: z
    .string()
    .min(1)
    .max(200)
    .regex(SLUG_PATTERN, "slug must match ^[a-z0-9-]+$ (lowercase alphanumerics and hyphens only)")
    .optional(),
});

/** Schema for update input — all fields optional */
export const UpdateArticleInputSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(100).optional(),
  content: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  codeRefs: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
  new_slug: z
    .string()
    .min(1)
    .max(200)
    .regex(SLUG_PATTERN, "new_slug must match ^[a-z0-9-]+$ (lowercase alphanumerics and hyphens only)")
    .optional(),
  rewrite_inline_wikilinks: z.boolean().optional(),
});

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
