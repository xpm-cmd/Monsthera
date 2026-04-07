import { z } from "zod/v4";
import type { Result } from "../core/result.js";
import { ok, err } from "../core/result.js";
import { ValidationError } from "../core/errors.js";

// ─── Schemas ─────────────────────────────────────────────────────────────────

/** Schema for work article frontmatter (parsed from YAML/markdown front matter) */
export const WorkArticleFrontmatterSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(200),
  template: z.enum(["feature", "bugfix", "refactor", "spike"]),
  phase: z.enum(["planning", "enrichment", "implementation", "review", "done", "cancelled"]),
  priority: z.enum(["critical", "high", "medium", "low"]),
  author: z.string().min(1),
  lead: z.string().optional(),
  assignee: z.string().optional(),
  tags: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
  codeRefs: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  blockedBy: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
});

/** Schema for create input (from MCP tool / service caller) */
export const CreateWorkArticleInputSchema = z.object({
  title: z.string().min(1).max(200),
  template: z.enum(["feature", "bugfix", "refactor", "spike"]),
  priority: z.enum(["critical", "high", "medium", "low"]),
  author: z.string().min(1),
  lead: z.string().optional(),
  tags: z.array(z.string()).default([]),
  content: z.string().optional(),
});

/** Schema for update input — all fields optional */
export const UpdateWorkArticleInputSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  priority: z.enum(["critical", "high", "medium", "low"]).optional(),
  lead: z.string().optional(),
  assignee: z.string().optional(),
  tags: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
  codeRefs: z.array(z.string()).optional(),
  content: z.string().optional(),
});

// ─── Inferred types ───────────────────────────────────────────────────────────

export type WorkArticleFrontmatter = z.infer<typeof WorkArticleFrontmatterSchema>;
export type CreateWorkInput = z.infer<typeof CreateWorkArticleInputSchema>;
export type UpdateWorkInput = z.infer<typeof UpdateWorkArticleInputSchema>;

// ─── Validation functions ─────────────────────────────────────────────────────

/** Validate raw create input and return a typed Result. */
export function validateCreateWorkInput(raw: unknown): Result<CreateWorkInput, ValidationError> {
  const result = CreateWorkArticleInputSchema.safeParse(raw);
  if (!result.success) {
    return err(
      new ValidationError("Invalid create work article input", {
        issues: result.error.issues,
      }),
    );
  }
  return ok(result.data);
}

/** Validate raw update input and return a typed Result. */
export function validateUpdateWorkInput(raw: unknown): Result<UpdateWorkInput, ValidationError> {
  const result = UpdateWorkArticleInputSchema.safeParse(raw);
  if (!result.success) {
    return err(
      new ValidationError("Invalid update work article input", {
        issues: result.error.issues,
      }),
    );
  }
  return ok(result.data);
}

/** Validate raw frontmatter (parsed from YAML) and return a typed Result. */
export function validateWorkFrontmatter(raw: unknown): Result<WorkArticleFrontmatter, ValidationError> {
  const result = WorkArticleFrontmatterSchema.safeParse(raw);
  if (!result.success) {
    return err(
      new ValidationError("Invalid work article frontmatter", {
        issues: result.error.issues,
      }),
    );
  }
  return ok(result.data);
}
