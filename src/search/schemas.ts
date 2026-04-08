import { z } from "zod/v4";
import type { Result } from "../core/result.js";
import { ok, err } from "../core/result.js";
import { ValidationError } from "../core/errors.js";

// ─── Schema ───────────────────────────────────────────────────────────────────

export const SearchInputSchema = z.object({
  query: z.string().min(1).transform((s) => s.trim()).pipe(z.string().min(1)),
  type: z.enum(["knowledge", "work", "all"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
});

// ─── Inferred type ────────────────────────────────────────────────────────────

export type SearchInput = z.infer<typeof SearchInputSchema>;

// ─── Validation function ──────────────────────────────────────────────────────

/** Validate raw search input and return a typed Result. */
export function validateSearchInput(raw: unknown): Result<SearchInput, ValidationError> {
  const result = SearchInputSchema.safeParse(raw);
  if (!result.success) {
    return err(
      new ValidationError("Invalid search input", {
        issues: result.error.issues,
      }),
    );
  }
  return ok(result.data);
}
