import { z } from "zod/v4";

export const PatchState = z.enum(["proposed", "validated", "applied", "committed", "stale", "failed"]);
export type PatchState = z.infer<typeof PatchState>;

export const PatchProposal = z.object({
  id: z.string(),
  repoId: z.string(),
  proposalId: z.string(), // idempotent ID to prevent duplicates
  baseCommit: z.string(), // invariant 2: required
  bundleId: z.string().optional(), // provenance link to Evidence Bundle
  state: PatchState,
  diff: z.string(), // unified diff
  message: z.string().min(1).max(1000),
  touchedPaths: z.array(z.string()).default([]),
  dryRunResult: z
    .object({
      feasible: z.boolean(),
      touchedPaths: z.array(z.string()),
      policyViolations: z.array(z.string()),
      secretWarnings: z.array(z.string()),
      reindexScope: z.number().int().nonnegative(), // estimated files to reindex
    })
    .nullable()
    .default(null),
  agentId: z.string(),
  sessionId: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  committedSha: z.string().nullable().default(null), // set after successful commit
  ticketId: z.string().nullable().default(null), // links patch to a ticket (TKT-...)
});
export type PatchProposal = z.infer<typeof PatchProposal>;

export const ProposePatchInput = z.object({
  diff: z.string().min(1),
  message: z.string().min(1).max(1000),
  baseCommit: z.string().min(7), // at least short SHA
  bundleId: z.string().optional(),
  dryRun: z.boolean().default(false),
  ticketId: z.string().optional(), // optional link to a ticket
});
export type ProposePatchInput = z.infer<typeof ProposePatchInput>;
