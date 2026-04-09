import type { AgentDirectorySummary } from "../agents/service.js";
import type { SystemStatus } from "../core/status.js";
import { getGuardSet, getNextPhase } from "../work/lifecycle.js";
import type { WorkArticle } from "../work/repository.js";
import { getTemplateConfig } from "../work/templates.js";

const TERMINAL_PHASES = new Set(["done", "cancelled"]);
const EXECUTION_PHASES = new Set(["implementation", "review"]);

export interface AgentCoverageMetric {
  readonly covered: number;
  readonly total: number;
  readonly missing: number;
  readonly percent: number;
}

export interface AgentExperienceRecommendation {
  readonly id: string;
  readonly severity: "high" | "medium" | "low";
  readonly impact: "save_tokens" | "reduce_handoffs" | "unblock_flow" | "accelerate_execution";
  readonly title: string;
  readonly detail: string;
  readonly path: string;
}

export interface AgentExperienceSnapshot {
  readonly generatedAt: string;
  readonly scores: {
    readonly overall: number;
    readonly contract: number;
    readonly context: number;
    readonly ownership: number;
    readonly review: number;
  };
  readonly work: {
    readonly activeCount: number;
    readonly terminalCount: number;
    readonly readyWaveCount: number;
    readonly blockedCount: number;
    readonly knowledgeCount: number;
  };
  readonly coverage: {
    readonly contract: AgentCoverageMetric;
    readonly context: AgentCoverageMetric;
    readonly knowledgeLinks: AgentCoverageMetric;
    readonly codeLinks: AgentCoverageMetric;
    readonly ownership: AgentCoverageMetric;
    readonly executionOwners: AgentCoverageMetric;
    readonly reviewAssignments: AgentCoverageMetric;
  };
  readonly automation: {
    readonly mode: "auto" | "supervised";
    readonly readyCount: number;
    readonly blockedCount: number;
    readonly activeAgents: number;
    readonly idleAgents: number;
    readonly nextAction: string;
  };
  readonly search: {
    readonly autoSync: true;
    readonly lastReindexAt?: string;
    readonly indexedDocuments?: number;
    readonly baselineReindexRecommended: boolean;
  };
  readonly recommendations: readonly AgentExperienceRecommendation[];
}

export interface AgentExperienceInput {
  readonly workArticles: readonly WorkArticle[];
  readonly knowledgeCount: number;
  readonly agentSummary?: AgentDirectorySummary;
  readonly status?: SystemStatus;
  readonly autoAdvanceEnabled: boolean;
  readonly waveSummary: {
    readonly readyCount: number;
    readonly blockedCount: number;
  };
}

function toPercent(covered: number, total: number): number {
  if (total <= 0) return 100;
  return Math.round((covered / total) * 100);
}

function metric(covered: number, total: number): AgentCoverageMetric {
  return {
    covered,
    total,
    missing: Math.max(total - covered, 0),
    percent: toPercent(covered, total),
  };
}

function hasRequiredSections(article: WorkArticle): boolean {
  const template = getTemplateConfig(article.template);
  return template.requiredSections.every((section) => article.content.includes(`## ${section}`));
}

function hasContextLinks(article: WorkArticle): boolean {
  return article.references.length > 0 || article.codeRefs.length > 0;
}

function hasExecutionOwner(article: WorkArticle): boolean {
  return Boolean(article.assignee);
}

function hasOwner(article: WorkArticle): boolean {
  return Boolean(article.lead || article.assignee);
}

function hasReviewAssignment(article: WorkArticle): boolean {
  return article.reviewers.length > 0;
}

function nextPhaseReady(article: WorkArticle): boolean {
  const nextPhase = getNextPhase(article.phase);
  if (!nextPhase) return false;
  return getGuardSet(article, article.phase, nextPhase).every((guard) => guard.check(article));
}

export function deriveAgentExperience(input: AgentExperienceInput): AgentExperienceSnapshot {
  const activeWork = input.workArticles.filter((article) => !TERMINAL_PHASES.has(article.phase));
  const terminalCount = input.workArticles.length - activeWork.length;
  const reviewArticles = activeWork.filter((article) => article.phase === "review");
  const executionArticles = activeWork.filter((article) => EXECUTION_PHASES.has(article.phase));
  const blockedCount = activeWork.filter((article) => article.blockedBy.length > 0).length;

  const contractCoverage = metric(activeWork.filter(hasRequiredSections).length, activeWork.length);
  const contextCoverage = metric(activeWork.filter(hasContextLinks).length, activeWork.length);
  const knowledgeCoverage = metric(activeWork.filter((article) => article.references.length > 0).length, activeWork.length);
  const codeCoverage = metric(activeWork.filter((article) => article.codeRefs.length > 0).length, activeWork.length);
  const ownershipCoverage = metric(activeWork.filter(hasOwner).length, activeWork.length);
  const executionOwnerCoverage = metric(executionArticles.filter(hasExecutionOwner).length, executionArticles.length);
  const reviewCoverage = metric(reviewArticles.filter(hasReviewAssignment).length, reviewArticles.length);

  const contractScore = contractCoverage.percent;
  const contextScore = contextCoverage.percent;
  const ownershipScore = Math.round((ownershipCoverage.percent + executionOwnerCoverage.percent) / 2);
  const reviewScore = reviewCoverage.percent;
  const overallScore = Math.round(
    contractScore * 0.35
    + contextScore * 0.25
    + ownershipScore * 0.25
    + reviewScore * 0.15,
  );

  const indexedDocuments =
    typeof input.status?.stats?.searchIndexSize === "number"
      ? input.status.stats.searchIndexSize
      : undefined;
  const lastReindexAt = input.status?.stats?.lastReindexAt;
  const baselineReindexRecommended = !lastReindexAt && (input.workArticles.length + input.knowledgeCount) > 0;

  const recommendations: AgentExperienceRecommendation[] = [];

  if (contractCoverage.missing > 0) {
    recommendations.push({
      id: "complete-required-sections",
      severity: "high",
      impact: "reduce_handoffs",
      title: "Complete the required work sections before adding more automation",
      detail: `${contractCoverage.missing} active article(s) are still missing template-required sections such as Objective, Acceptance Criteria, Context, or Scope.`,
      path: "/work",
    });
  }

  if (contextCoverage.missing > 0) {
    recommendations.push({
      id: "add-context-links",
      severity: "medium",
      impact: "save_tokens",
      title: "Attach references or code refs to reduce rediscovery",
      detail: `${contextCoverage.missing} active article(s) still force agents to re-read raw context because they have neither knowledge references nor code refs.`,
      path: "/work",
    });
  }

  if (ownershipCoverage.missing > 0) {
    recommendations.push({
      id: "assign-owners",
      severity: "high",
      impact: "reduce_handoffs",
      title: "Clarify ownership on active work",
      detail: `${ownershipCoverage.missing} active article(s) still lack a lead or assignee, which makes planning and handoffs slower for agents.`,
      path: "/work",
    });
  }

  if (executionOwnerCoverage.missing > 0) {
    recommendations.push({
      id: "assign-assignees",
      severity: "high",
      impact: "accelerate_execution",
      title: "Assign implementation owners before review handoffs",
      detail: `${executionOwnerCoverage.missing} implementation/review article(s) still lack an assignee, so execution and follow-up are not anchored to a responsible agent.`,
      path: "/work",
    });
  }

  if (reviewCoverage.missing > 0) {
    recommendations.push({
      id: "assign-reviewers",
      severity: "high",
      impact: "unblock_flow",
      title: "Assign reviewers to review-phase work",
      detail: `${reviewCoverage.missing} review article(s) are waiting without reviewers, so “done” cannot become a safe automated outcome.`,
      path: "/work",
    });
  }

  if (blockedCount > 0) {
    recommendations.push({
      id: "resolve-blockers",
      severity: "medium",
      impact: "unblock_flow",
      title: "Resolve explicit blockers before expanding the wave",
      detail: `${blockedCount} active article(s) are blocked by dependencies. Clearing those blockers will improve throughput more than creating new work.`,
      path: "/flow",
    });
  }

  if (input.waveSummary.readyCount > 0 && !input.autoAdvanceEnabled) {
    recommendations.push({
      id: "run-ready-wave",
      severity: "low",
      impact: "accelerate_execution",
      title: "Use the ready wave to advance safe work under supervision",
      detail: `${input.waveSummary.readyCount} article(s) already satisfy their next-phase guards. Running the wave now speeds progress without adding ambiguity.`,
      path: "/flow",
    });
  }

  if (baselineReindexRecommended) {
    recommendations.push({
      id: "baseline-reindex",
      severity: "low",
      impact: "save_tokens",
      title: "Run one baseline reindex after migrations or bulk imports",
      detail: "Search sync is automatic for normal create/update/delete flows. Use full reindex only after a bulk import, migration, or recovery event.",
      path: "/system/models",
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    scores: {
      overall: overallScore,
      contract: contractScore,
      context: contextScore,
      ownership: ownershipScore,
      review: reviewScore,
    },
    work: {
      activeCount: activeWork.length,
      terminalCount,
      readyWaveCount: input.waveSummary.readyCount,
      blockedCount: input.waveSummary.blockedCount,
      knowledgeCount: input.knowledgeCount,
    },
    coverage: {
      contract: contractCoverage,
      context: contextCoverage,
      knowledgeLinks: knowledgeCoverage,
      codeLinks: codeCoverage,
      ownership: ownershipCoverage,
      executionOwners: executionOwnerCoverage,
      reviewAssignments: reviewCoverage,
    },
    automation: {
      mode: input.autoAdvanceEnabled ? "auto" : "supervised",
      readyCount: input.waveSummary.readyCount,
      blockedCount: input.waveSummary.blockedCount,
      activeAgents: input.agentSummary?.activeAgents ?? 0,
      idleAgents: input.agentSummary?.idleAgents ?? 0,
      nextAction:
        input.waveSummary.readyCount > 0 && !input.autoAdvanceEnabled
          ? "Run the ready wave under supervision."
          : input.waveSummary.blockedCount > 0
            ? "Resolve blockers or missing guards before expecting more automation."
            : activeWork.some(nextPhaseReady)
              ? "Keep contracts sharp and let the next ready wave form naturally."
              : "Capture more context or create the next work contract.",
    },
    search: {
      autoSync: true,
      lastReindexAt,
      indexedDocuments,
      baselineReindexRecommended,
    },
    recommendations,
  };
}
