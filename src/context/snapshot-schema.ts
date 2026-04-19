import { z } from "zod/v4";
import type { Result } from "../core/result.js";
import { ok, err } from "../core/result.js";
import { ValidationError } from "../core/errors.js";

const GitRefSchema = z.object({
  branch: z.string().optional(),
  sha: z.string().optional(),
  dirty: z.boolean().optional(),
});

const LockfileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().min(1),
});

const MemorySchema = z.object({
  totalMb: z.number().nonnegative(),
  availableMb: z.number().nonnegative(),
});

/** Input accepted by the record tool — callers supply every field except id/capturedAt. */
export const RecordSnapshotInputSchema = z.object({
  agentId: z.string().min(1),
  workId: z.string().optional(),
  cwd: z.string().min(1),
  gitRef: GitRefSchema.optional(),
  files: z.array(z.string()).default([]),
  runtimes: z.record(z.string(), z.string()).default({}),
  packageManagers: z.array(z.string()).default([]),
  lockfiles: z.array(LockfileSchema).default([]),
  memory: MemorySchema.optional(),
  raw: z.string().optional(),
});

/** Full stored snapshot — id and capturedAt are assigned by the service. */
export const EnvironmentSnapshotSchema = RecordSnapshotInputSchema.extend({
  id: z.string().regex(/^s-[a-z0-9]+$/),
  capturedAt: z.string(),
});

export type RecordSnapshotInput = z.infer<typeof RecordSnapshotInputSchema>;
export type EnvironmentSnapshot = z.infer<typeof EnvironmentSnapshotSchema>;
export type SnapshotGitRef = z.infer<typeof GitRefSchema>;
export type SnapshotLockfile = z.infer<typeof LockfileSchema>;

export function validateRecordSnapshotInput(
  raw: unknown,
): Result<RecordSnapshotInput, ValidationError> {
  const result = RecordSnapshotInputSchema.safeParse(raw);
  if (!result.success) {
    return err(
      new ValidationError("Invalid environment snapshot input", {
        issues: result.error.issues,
      }),
    );
  }
  return ok(result.data);
}

/** Shape returned by compare — which fields changed between two snapshots. */
export interface SnapshotDiff {
  readonly leftId: string;
  readonly rightId: string;
  readonly ageDeltaSeconds: number;
  readonly cwdChanged: boolean;
  readonly branchChanged: boolean;
  readonly shaChanged: boolean;
  readonly dirtyChanged: boolean;
  readonly runtimesChanged: readonly string[];
  readonly packageManagersChanged: boolean;
  readonly lockfilesChanged: readonly string[];
}
