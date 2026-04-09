import { z } from "zod/v4";
import type { Result } from "../core/result.js";
import { ok, err } from "../core/result.js";
import { ValidationError } from "../core/errors.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

/** Schema for article frontmatter (parsed from YAML/markdown front matter) */
export const ArticleFrontmatterSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  slug: z.string(),
  category: z.string().min(1).max(100),
  tags: z.array(z.string()).default([]),
  codeRefs: z.array(z.string()).default([]),
  sourcePath: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** Schema for create input (from MCP tool / service caller) */
export const CreateArticleInputSchema = z.object({
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
  codeRefs: z.array(z.string()).default([]),
});

/** Schema for update input — all fields optional */
export const UpdateArticleInputSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(100).optional(),
  content: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  codeRefs: z.array(z.string()).optional(),
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
