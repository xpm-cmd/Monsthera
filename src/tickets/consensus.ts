import {
  COUNCIL_SPECIALIZATIONS,
  CouncilSpecializationId,
  CouncilVerdict,
} from "../../schemas/council.js";
import type {
  CouncilSpecializationId as CouncilSpecializationIdValue,
  CouncilVerdict as CouncilVerdictValue,
} from "../../schemas/council.js";
import type { TicketStatus } from "../../schemas/ticket.js";
import type { TicketQuorumConfig } from "../core/config.js";

export interface ReviewVerdictRecord {
  specialization: string;
  verdict: string;
  agentId: string;
  sessionId: string;
  reasoning: string | null;
  createdAt: string;
}

export interface ConsensusCounts {
  pass: number;
  fail: number;
  abstain: number;
  responded: number;
  missing: number;
}

export interface ConsensusPayload {
  ticketId: string;
  councilSpecializations: CouncilSpecializationIdValue[];
  vetoSpecializations: CouncilSpecializationIdValue[];
  requiredPasses: number;
  counts: ConsensusCounts;
  quorumMet: boolean;
  blockedByVeto: boolean;
  advisoryReady: boolean;
  missingSpecializations: CouncilSpecializationIdValue[];
  vetoes: NormalizedReviewVerdictRecord[];
  verdicts: NormalizedReviewVerdictRecord[];
}

export const GATED_TICKET_TRANSITIONS = [
  "technical_analysis→approved",
  "in_review→ready_for_commit",
] as const;

export type GatedTicketTransition = typeof GATED_TICKET_TRANSITIONS[number];

const DEFAULT_VETO_SPECIALIZATIONS: CouncilSpecializationIdValue[] = ["architect", "security"];

const TICKET_QUORUM_RULES: Record<GatedTicketTransition, keyof TicketQuorumConfig> = {
  "technical_analysis→approved": "technicalAnalysisToApproved",
  "in_review→ready_for_commit": "inReviewToReadyForCommit",
};

export interface ResolvedTicketQuorumRule {
  transition: GatedTicketTransition;
  key: keyof TicketQuorumConfig;
  requiredPasses: number;
  vetoSpecializations: CouncilSpecializationIdValue[];
}

export interface TransitionConsensusPayload extends ConsensusPayload {
  transition: GatedTicketTransition;
  ruleKey: keyof TicketQuorumConfig;
}

export interface DisabledTransitionConsensusPayload extends ConsensusPayload {
  transition: GatedTicketTransition;
  ruleKey: keyof TicketQuorumConfig;
  enforcementEnabled: false;
}

export interface EnabledTransitionConsensusPayload extends TransitionConsensusPayload {
  enforcementEnabled: true;
}

export type TicketConsensusReport =
  | ConsensusPayload
  | DisabledTransitionConsensusPayload
  | EnabledTransitionConsensusPayload;

export interface NormalizedReviewVerdictRecord {
  specialization: CouncilSpecializationIdValue;
  verdict: CouncilVerdictValue;
  agentId: string;
  sessionId: string;
  reasoning: string | null;
  createdAt: string;
}

export function getDefaultAdvisoryPasses(totalSpecializations = COUNCIL_SPECIALIZATIONS.length): number {
  // Current council guidance is 3/5 and 4/6; keeping a simple total-2 rule preserves both.
  return Math.max(1, totalSpecializations - 2);
}

export function buildConsensusPayload(
  ticketId: string,
  verdictRows: ReviewVerdictRecord[],
  options?: {
    requiredPasses?: number;
    vetoSpecializations?: readonly CouncilSpecializationIdValue[];
  },
): ConsensusPayload {
  const vetoSpecializations = dedupeSpecializations(options?.vetoSpecializations ?? DEFAULT_VETO_SPECIALIZATIONS);
  const normalizedVerdicts = normalizeVerdictRows(verdictRows);
  const verdicts = COUNCIL_SPECIALIZATIONS.flatMap((specialization) => {
    const verdict = normalizedVerdicts.find((entry) => entry.specialization === specialization);
    return verdict ? [{ ...verdict }] : [];
  });
  const missingSpecializations = COUNCIL_SPECIALIZATIONS.filter(
    (specialization) => !verdicts.some((entry) => entry.specialization === specialization),
  );
  const vetoes = verdicts.filter(
    (entry) => entry.verdict === "fail" && vetoSpecializations.includes(entry.specialization),
  );
  const counts: ConsensusCounts = {
    pass: verdicts.filter((entry) => entry.verdict === "pass").length,
    fail: verdicts.filter((entry) => entry.verdict === "fail").length,
    abstain: verdicts.filter((entry) => entry.verdict === "abstain").length,
    responded: verdicts.length,
    missing: missingSpecializations.length,
  };
  const requiredPasses = options?.requiredPasses ?? getDefaultAdvisoryPasses(COUNCIL_SPECIALIZATIONS.length);
  const quorumMet = counts.pass >= requiredPasses;

  return {
    ticketId,
    councilSpecializations: [...COUNCIL_SPECIALIZATIONS],
    vetoSpecializations,
    requiredPasses,
    counts,
    quorumMet,
    blockedByVeto: vetoes.length > 0,
    advisoryReady: quorumMet && vetoes.length === 0,
    missingSpecializations,
    vetoes,
    verdicts,
  };
}

export function buildTicketConsensusReport(input: {
  ticketId: string;
  verdictRows: ReviewVerdictRecord[];
  config?: TicketQuorumConfig | null;
  transition?: GatedTicketTransition | null;
}): TicketConsensusReport {
  if (!input.transition) {
    return buildConsensusPayload(input.ticketId, input.verdictRows);
  }

  const key = TICKET_QUORUM_RULES[input.transition];
  const rule = input.config?.[key];
  if (rule?.enabled === false) {
    return {
      ...buildConsensusPayload(input.ticketId, input.verdictRows),
      transition: input.transition,
      ruleKey: key,
      enforcementEnabled: false,
    };
  }

  const requiredPasses = rule?.requiredPasses ?? getDefaultAdvisoryPasses(COUNCIL_SPECIALIZATIONS.length);
  const vetoSpecializations = dedupeSpecializations(rule?.vetoSpecializations ?? DEFAULT_VETO_SPECIALIZATIONS);
  return {
    ...buildConsensusPayload(input.ticketId, input.verdictRows, {
      requiredPasses,
      vetoSpecializations,
    }),
    transition: input.transition,
    ruleKey: key,
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

export function resolveTicketQuorumRule(
  fromStatus: TicketStatus,
  toStatus: TicketStatus,
  config?: TicketQuorumConfig | null,
): ResolvedTicketQuorumRule | null {
  const transition = `${fromStatus}→${toStatus}`;
  if (!isGatedTicketTransition(transition)) {
    return null;
  }

  const key = TICKET_QUORUM_RULES[transition];
  const rule = config?.[key];
  if (rule?.enabled === false) {
    return null;
  }

  return {
    transition,
    key,
    requiredPasses: rule?.requiredPasses ?? getDefaultAdvisoryPasses(COUNCIL_SPECIALIZATIONS.length),
    vetoSpecializations: dedupeSpecializations(rule?.vetoSpecializations ?? DEFAULT_VETO_SPECIALIZATIONS),
  };
}

export function evaluateTicketTransitionConsensus(input: {
  ticketId: string;
  fromStatus: TicketStatus;
  toStatus: TicketStatus;
  verdictRows: ReviewVerdictRecord[];
  config?: TicketQuorumConfig | null;
}): TransitionConsensusPayload | null {
  const rule = resolveTicketQuorumRule(input.fromStatus, input.toStatus, input.config);
  if (!rule) return null;

  return {
    ...buildConsensusPayload(input.ticketId, input.verdictRows, {
      requiredPasses: rule.requiredPasses,
      vetoSpecializations: rule.vetoSpecializations,
    }),
    transition: rule.transition,
    ruleKey: rule.key,
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
