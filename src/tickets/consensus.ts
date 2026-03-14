import {
  COUNCIL_SPECIALIZATIONS,
  CouncilSpecializationId,
  CouncilVerdict,
} from "../../schemas/council.js";
import type {
  CouncilSpecializationId as CouncilSpecializationIdValue,
  CouncilVerdict as CouncilVerdictValue,
} from "../../schemas/council.js";
import { GOVERNANCE_ANALYTICAL_SPECIALIZATIONS } from "../../schemas/governance.js";
import type { TicketStatus } from "../../schemas/ticket.js";
import type { TicketQuorumConfig, GovernanceConfig } from "../core/config.js";

// ─── Input / output types ─────────────────────────────────────

export interface ReviewVerdictRecord {
  specialization: string;
  verdict: string;
  agentId: string;
  sessionId: string;
  reasoning: string | null;
  createdAt: string;
}

export interface NormalizedReviewVerdictRecord {
  specialization: CouncilSpecializationIdValue;
  verdict: CouncilVerdictValue;
  agentId: string;
  sessionId: string;
  reasoning: string | null;
  createdAt: string;
}

export interface AgentIdentity {
  provider: string | null;
  model: string | null;
}

export interface ModelDiversityResult {
  distinctModels: number;
  totalVoters: number;
  diversityEligible: number;
  ineligibleAgentIds: string[];
  duplicateGroups: Array<{ provider: string; model: string; agentIds: string[]; specializations: CouncilSpecializationIdValue[] }>;
  diversityMet: boolean;
}

export interface GovernanceEvaluation {
  nonVotingExcluded: NormalizedReviewVerdictRecord[];
  modelDiversity: ModelDiversityResult | null;
}

export interface ConsensusGovernanceOptions {
  nonVotingAgentIds?: string[];
  agentIdentities?: ReadonlyMap<string, AgentIdentity>;
  strictDiversity?: boolean;
}

// ─── Consensus payload (flat) ─────────────────────────────────

export interface ConsensusPayload {
  ticketId: string;
  councilSpecializations: CouncilSpecializationIdValue[];
  vetoSpecializations: CouncilSpecializationIdValue[];
  requiredPasses: number;
  counts: {
    pass: number;
    fail: number;
    abstain: number;
    responded: number;
    missing: number;
  };
  quorumMet: boolean;
  blockedByVeto: boolean;
  advisoryReady: boolean;
  missingSpecializations: CouncilSpecializationIdValue[];
  vetoes: NormalizedReviewVerdictRecord[];
  verdicts: NormalizedReviewVerdictRecord[];
  governance?: GovernanceEvaluation;
  transition?: GatedTicketTransition;
  enforcementEnabled?: boolean;
}

// ─── Gated transitions ────────────────────────────────────────

export const GATED_TICKET_TRANSITIONS = [
  "technical_analysis→approved",
  "in_review→ready_for_commit",
] as const;

export type GatedTicketTransition = typeof GATED_TICKET_TRANSITIONS[number];

export const GATED_ADVANCE_TARGET: Readonly<Partial<Record<TicketStatus, TicketStatus>>> = {
  technical_analysis: "approved",
  in_review: "ready_for_commit",
};

// ─── Internal helpers ─────────────────────────────────────────

const DEFAULT_VETO_SPECIALIZATIONS: CouncilSpecializationIdValue[] = ["architect", "security"];

function getDefaultAdvisoryPasses(totalSpecializations = COUNCIL_SPECIALIZATIONS.length): number {
  return Math.max(1, totalSpecializations - 2);
}

function resolveQuorumParams(
  config: TicketQuorumConfig | null | undefined,
  governanceEnabled: boolean,
): { requiredPasses: number; vetoSpecializations: CouncilSpecializationIdValue[] } | null {
  if (config?.enabled === false) return null;
  return {
    requiredPasses: config?.requiredPasses ?? (governanceEnabled
      ? Math.max(1, GOVERNANCE_ANALYTICAL_SPECIALIZATIONS.length - 1)
      : getDefaultAdvisoryPasses(COUNCIL_SPECIALIZATIONS.length)),
    vetoSpecializations: dedupeSpecializations(config?.vetoSpecializations ?? DEFAULT_VETO_SPECIALIZATIONS),
  };
}

function dedupeSpecializations(values: readonly CouncilSpecializationIdValue[]): CouncilSpecializationIdValue[] {
  return [...new Set(values)];
}

function normalizeVerdictRows(verdictRows: ReviewVerdictRecord[]): NormalizedReviewVerdictRecord[] {
  return verdictRows.flatMap((row) => {
    const specialization = CouncilSpecializationId.safeParse(row.specialization);
    const verdict = CouncilVerdict.safeParse(row.verdict);
    if (!specialization.success || !verdict.success) {
      return [];
    }
    return [{
      specialization: specialization.data,
      verdict: verdict.data,
      agentId: row.agentId,
      sessionId: row.sessionId,
      reasoning: row.reasoning,
      createdAt: row.createdAt,
    }];
  });
}

function isGatedTicketTransition(value: string): value is GatedTicketTransition {
  return (GATED_TICKET_TRANSITIONS as readonly string[]).includes(value);
}

function countDiversityAdjustedPasses(
  verdicts: NormalizedReviewVerdictRecord[],
  agentIdentities: ReadonlyMap<string, AgentIdentity>,
): number {
  const passVerdicts = verdicts.filter((v) => v.verdict === "pass");
  const seenModels = new Set<string>();
  let count = 0;
  for (const v of passVerdicts) {
    const identity = agentIdentities.get(v.agentId);
    if (!identity?.provider || !identity?.model) continue;
    const key = `${identity.provider}::${identity.model}`;
    if (!seenModels.has(key)) {
      seenModels.add(key);
      count++;
    }
  }
  return count;
}

// ─── Public API ───────────────────────────────────────────────

export function buildConsensusPayload(
  ticketId: string,
  verdictRows: ReviewVerdictRecord[],
  options?: {
    requiredPasses?: number;
    vetoSpecializations?: readonly CouncilSpecializationIdValue[];
    councilSpecializations?: readonly CouncilSpecializationIdValue[];
    governance?: ConsensusGovernanceOptions;
  },
): ConsensusPayload {
  const vetoSpecializations = dedupeSpecializations(options?.vetoSpecializations ?? DEFAULT_VETO_SPECIALIZATIONS);
  const allNormalized = normalizeVerdictRows(verdictRows);
  const gov = options?.governance;
  const councilSpecializations = dedupeSpecializations(options?.councilSpecializations ?? (gov
    ? GOVERNANCE_ANALYTICAL_SPECIALIZATIONS
    : COUNCIL_SPECIALIZATIONS));

  const nonVotingIds = gov?.nonVotingAgentIds ?? [];
  const nonVotingExcluded = nonVotingIds.length > 0
    ? allNormalized.filter((v) => nonVotingIds.includes(v.agentId))
    : [];
  const normalizedVerdicts = nonVotingIds.length > 0
    ? allNormalized.filter((v) => !nonVotingIds.includes(v.agentId))
    : allNormalized;

  const verdicts = councilSpecializations.flatMap((specialization) => {
    const verdict = normalizedVerdicts.find((entry) => entry.specialization === specialization);
    return verdict ? [{ ...verdict }] : [];
  });
  const missingSpecializations = councilSpecializations.filter(
    (specialization) => !verdicts.some((entry) => entry.specialization === specialization),
  );
  const vetoes = verdicts.filter(
    (entry) => entry.verdict === "fail" && vetoSpecializations.includes(entry.specialization),
  );

  const diversityResult = gov?.agentIdentities
    ? evaluateModelDiversity(verdicts, gov.agentIdentities)
    : null;

  const effectivePassCount = gov?.strictDiversity && diversityResult
    ? countDiversityAdjustedPasses(verdicts, gov.agentIdentities!)
    : verdicts.filter((entry) => entry.verdict === "pass").length;

  const counts = {
    pass: effectivePassCount,
    fail: verdicts.filter((entry) => entry.verdict === "fail").length,
    abstain: verdicts.filter((entry) => entry.verdict === "abstain").length,
    responded: verdicts.length,
    missing: missingSpecializations.length,
  };
  const requiredPasses = options?.requiredPasses
    ?? (gov || options?.councilSpecializations
      ? Math.max(1, councilSpecializations.length - 1)
      : getDefaultAdvisoryPasses(councilSpecializations.length));
  const quorumMet = counts.pass >= requiredPasses;
  const blockedByVeto = vetoes.length > 0;
  const diversityBlocked = gov?.strictDiversity === true && diversityResult != null && !diversityResult.diversityMet;

  const governance: GovernanceEvaluation | undefined = gov
    ? { nonVotingExcluded, modelDiversity: diversityResult }
    : undefined;

  return {
    ticketId,
    councilSpecializations: [...councilSpecializations],
    vetoSpecializations,
    requiredPasses,
    counts,
    quorumMet,
    blockedByVeto,
    advisoryReady: quorumMet && !blockedByVeto && !diversityBlocked,
    missingSpecializations,
    vetoes,
    verdicts,
    governance,
  };
}

export function buildTicketConsensusReport(input: {
  ticketId: string;
  verdictRows: ReviewVerdictRecord[];
  config?: TicketQuorumConfig | null;
  transition?: GatedTicketTransition | null;
  governance?: ConsensusGovernanceOptions;
}): ConsensusPayload {
  if (!input.transition) {
    return buildConsensusPayload(input.ticketId, input.verdictRows, {
      governance: input.governance,
    });
  }

  const params = resolveQuorumParams(input.config, !!input.governance);
  if (!params) {
    return {
      ...buildConsensusPayload(input.ticketId, input.verdictRows, {
        governance: input.governance,
      }),
      transition: input.transition,
      enforcementEnabled: false,
    };
  }

  return {
    ...buildConsensusPayload(input.ticketId, input.verdictRows, {
      requiredPasses: params.requiredPasses,
      vetoSpecializations: params.vetoSpecializations,
      governance: input.governance,
    }),
    transition: input.transition,
    enforcementEnabled: true,
  };
}

export function inferConsensusTransitionForTicketStatus(status: TicketStatus): GatedTicketTransition | null {
  switch (status) {
    case "technical_analysis":
      return "technical_analysis→approved";
    case "in_review":
      return "in_review→ready_for_commit";
    default:
      return null;
  }
}

export function evaluateTicketTransitionConsensus(input: {
  ticketId: string;
  fromStatus: TicketStatus;
  toStatus: TicketStatus;
  verdictRows: ReviewVerdictRecord[];
  config?: TicketQuorumConfig | null;
  governance?: ConsensusGovernanceOptions;
}): ConsensusPayload | null {
  const transition = `${input.fromStatus}→${input.toStatus}`;
  if (!isGatedTicketTransition(transition)) return null;

  const params = resolveQuorumParams(input.config, !!input.governance);
  if (!params) return null;

  return {
    ...buildConsensusPayload(input.ticketId, input.verdictRows, {
      requiredPasses: params.requiredPasses,
      vetoSpecializations: params.vetoSpecializations,
      governance: input.governance,
    }),
    transition,
  };
}

export function buildGovernanceOptions(
  governance: GovernanceConfig | undefined,
  verdictRows: ReviewVerdictRecord[],
  getAgentRecord: (agentId: string) => { roleId: string; provider: string | null; model: string | null } | undefined,
): ConsensusGovernanceOptions | undefined {
  if (!governance) return undefined;

  const uniqueAgentIds = [...new Set(verdictRows.map((v) => v.agentId))];
  const agentRecords = new Map(
    uniqueAgentIds.flatMap((id) => {
      const agent = getAgentRecord(id);
      return agent ? [[id, agent] as const] : [];
    }),
  );

  const nonVotingRoles = governance.nonVotingRoles ?? [];
  const nonVotingAgentIds = uniqueAgentIds.filter((id) => {
    const agent = agentRecords.get(id);
    return agent && nonVotingRoles.includes(agent.roleId as GovernanceConfig["nonVotingRoles"][number]);
  });

  const agentIdentities = new Map(
    [...agentRecords.entries()].map(([id, agent]) => [id, { provider: agent.provider, model: agent.model }]),
  );

  return {
    nonVotingAgentIds,
    agentIdentities,
    strictDiversity: governance.modelDiversity?.strict ?? false,
  };
}

export function evaluateModelDiversity(
  verdicts: NormalizedReviewVerdictRecord[],
  agentIdentities: ReadonlyMap<string, AgentIdentity>,
): ModelDiversityResult {
  const passVerdicts = verdicts.filter((v) => v.verdict === "pass");
  const ineligibleAgentIds: string[] = [];
  const modelMap = new Map<string, { provider: string; model: string; agentIds: string[]; specializations: CouncilSpecializationIdValue[] }>();

  for (const v of passVerdicts) {
    const identity = agentIdentities.get(v.agentId);
    if (!identity?.provider || !identity?.model) {
      ineligibleAgentIds.push(v.agentId);
      continue;
    }
    const key = `${identity.provider}::${identity.model}`;
    const existing = modelMap.get(key);
    if (existing) {
      if (!existing.agentIds.includes(v.agentId)) existing.agentIds.push(v.agentId);
      existing.specializations.push(v.specialization);
    } else {
      modelMap.set(key, {
        provider: identity.provider,
        model: identity.model,
        agentIds: [v.agentId],
        specializations: [v.specialization],
      });
    }
  }

  const duplicateGroups = [...modelMap.values()].filter((g) => g.specializations.length > 1);
  const diversityEligible = passVerdicts.length - ineligibleAgentIds.length;

  return {
    distinctModels: modelMap.size,
    totalVoters: passVerdicts.length,
    diversityEligible,
    ineligibleAgentIds: [...new Set(ineligibleAgentIds)],
    duplicateGroups,
    diversityMet: duplicateGroups.length === 0 && ineligibleAgentIds.length === 0,
  };
}
