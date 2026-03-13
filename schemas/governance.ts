import { z } from "zod/v4";
import { COUNCIL_SPECIALIZATIONS, type CouncilSpecializationId as CouncilSpecializationIdValue } from "./council.js";
import { RoleId } from "./agent.js";

const NON_ANALYTICAL_SPECIALIZATIONS = new Set<CouncilSpecializationIdValue>(["design"]);

export const GOVERNANCE_ANALYTICAL_SPECIALIZATIONS: CouncilSpecializationIdValue[] =
  COUNCIL_SPECIALIZATIONS.filter((s) => !NON_ANALYTICAL_SPECIALIZATIONS.has(s));

/**
 * Model diversity configuration for council governance.
 * When strict is true, verdicts from agents sharing the same normalized
 * provider+model pair are deduplicated — only one counts toward quorum.
 */
export const ModelDiversityConfigSchema = z.object({
  strict: z.boolean().default(false),
});

/**
 * Governance policy configuration for facilitator-driven council transitions.
 *
 * - nonVotingRoles: roles whose verdicts are recorded but excluded from quorum
 *   counting (default: facilitator is a non-voting coordinator).
 * - modelDiversity: controls whether verdicts must come from distinct provider+model
 *   combinations to count toward quorum.
 * - requireBinding: when true, advisory verdicts require an explicit
 *   per-ticket specialization assignment before they are accepted.
 */
export const GovernanceConfigSchema = z.object({
  nonVotingRoles: z.array(RoleId).default(["facilitator"]),
  modelDiversity: ModelDiversityConfigSchema.default({ strict: false }),
  requireBinding: z.boolean().default(false),
  autoAdvance: z.boolean().default(true),
});

export type GovernanceConfig = z.infer<typeof GovernanceConfigSchema>;
export type ModelDiversityConfig = z.infer<typeof ModelDiversityConfigSchema>;
