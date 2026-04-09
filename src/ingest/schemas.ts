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
