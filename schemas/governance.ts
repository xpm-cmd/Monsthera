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
 * maxVotersPerModel caps how many distinct reviewers on the same provider+model
 * may actively vote on a single council gate.
 */
export const ModelDiversityConfigSchema = z.object({
  strict: z.boolean().default(true),
  maxVotersPerModel: z.number().int().min(1).max(COUNCIL_SPECIALIZATIONS.length).default(3),
});

export const ReviewerIndependenceConfigSchema = z.object({
  strict: z.boolean().default(true),
  identityKey: z.enum(["agent", "agent_session"]).default("agent"),
});

export const BacklogPlanningGateConfigSchema = z.object({
  enforce: z.boolean().default(true),
  minIterations: z.number().int().min(1).max(20).default(3),
  requiredDistinctModels: z.number().int().min(1).max(COUNCIL_SPECIALIZATIONS.length).default(2),
});

/**
 * Governance policy configuration for facilitator-driven council transitions.
 *
 * - nonVotingRoles: roles whose verdicts are recorded but excluded from quorum
 *   counting (default: facilitator is a non-voting coordinator).
 * - modelDiversity: controls whether verdicts must come from distinct provider+model
 *   combinations to count toward quorum.
 * - backlogPlanningGate: controls the minimum planning iteration depth required
 *   before a ticket may leave backlog for technical analysis.
 * - requireBinding: when true, advisory verdicts require an explicit
 *   per-ticket specialization assignment before they are accepted.
 */
export const GovernanceConfigSchema = z.object({
  nonVotingRoles: z.array(RoleId).default(["facilitator"]),
  modelDiversity: ModelDiversityConfigSchema.default({ strict: false, maxVotersPerModel: 3 }),
  reviewerIndependence: ReviewerIndependenceConfigSchema.default({ strict: true, identityKey: "agent" }),
  backlogPlanningGate: BacklogPlanningGateConfigSchema.default({
    enforce: true,
    minIterations: 3,
    requiredDistinctModels: 2,
  }),
  requireBinding: z.boolean().default(false),
  autoAdvance: z.boolean().default(true),
  autoAdvanceExcludedTags: z.array(z.string().min(1).max(64)).default(["umbrella", "tracking", "discussion"]),
});

export type GovernanceConfig = z.infer<typeof GovernanceConfigSchema>;
export type ModelDiversityConfig = z.infer<typeof ModelDiversityConfigSchema>;
export type ReviewerIndependenceConfig = z.infer<typeof ReviewerIndependenceConfigSchema>;
export type BacklogPlanningGateConfig = z.infer<typeof BacklogPlanningGateConfigSchema>;
