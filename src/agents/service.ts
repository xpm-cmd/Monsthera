import { NotFoundError } from "../core/errors.js";
import type { StorageError } from "../core/errors.js";
import type { Logger } from "../core/logger.js";
import { err, ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import { timestamp, WorkPhase } from "../core/types.js";
import type { OrchestrationEventRepository } from "../orchestration/repository.js";
import type { WorkArticleRepository, WorkArticle } from "../work/repository.js";

const TERMINAL_PHASES = new Set<string>([WorkPhase.DONE, WorkPhase.CANCELLED]);
const RECENT_EVENT_LIMIT = 250;
const PROFILE_EVENT_LIMIT = 8;

export interface AgentTouchpoint {
  readonly workId: string;
  readonly title: string;
  readonly phase: string;
  readonly priority: string;
  readonly updatedAt: string;
  readonly blockedByCount: number;
  readonly roles: readonly string[];
  readonly reviewStatuses: readonly string[];
  readonly enrichmentRoles: ReadonlyArray<{
    readonly role: string;
    readonly status: string;
  }>;
}

export interface AgentCurrentFocus {
  readonly workId: string;
  readonly title: string;
  readonly phase: string;
  readonly actionLabel: string;
  readonly updatedAt: string;
  readonly roles: readonly string[];
}

export interface AgentRecentEvent {
  readonly id: string;
  readonly workId: string;
  readonly workTitle?: string;
  readonly eventType: string;
  readonly createdAt: string;
  readonly direct: boolean;
  readonly details: Record<string, unknown>;
}

export interface AgentProfile {
  readonly id: string;
  readonly status: "active" | "idle";
  readonly roles: readonly string[];
  readonly workCount: number;
  readonly activeWorkCount: number;
  readonly blockedWorkCount: number;
  readonly authoredCount: number;
  readonly leadCount: number;
  readonly assignedCount: number;
  readonly pendingReviewCount: number;
  readonly completedReviewCount: number;
  readonly enrichmentPendingCount: number;
  readonly enrichmentContributedCount: number;
  readonly enrichmentSkippedCount: number;
  readonly directEventCount: number;
  readonly relatedEventCount: number;
  readonly phaseCounts: Readonly<Record<string, number>>;
  readonly lastActivityAt?: string;
  readonly current?: AgentCurrentFocus;
  readonly touchpoints: readonly AgentTouchpoint[];
  readonly recentEvents: readonly AgentRecentEvent[];
}

export interface AgentDirectorySummary {
  readonly totalAgents: number;
  readonly activeAgents: number;
  readonly idleAgents: number;
  readonly reviewAgents: number;
  readonly enrichmentAgents: number;
  readonly directEventCount: number;
  readonly relatedEventCount: number;
  readonly currentPhaseCounts: Readonly<Record<string, number>>;
}

export interface AgentDirectory {
  readonly generatedAt: string;
  readonly summary: AgentDirectorySummary;
  readonly agents: readonly AgentProfile[];
}

export interface AgentServiceDeps {
  readonly workRepo: WorkArticleRepository;
  readonly orchestrationRepo: OrchestrationEventRepository;
  readonly logger: Logger;
}

interface MutableTouchpoint {
  workId: string;
  title: string;
  phase: string;
  priority: string;
  updatedAt: string;
  blockedByCount: number;
  roles: Set<string>;
  reviewStatuses: Set<string>;
  enrichmentRoles: Array<{ role: string; status: string }>;
}

interface MutableProfile {
  id: string;
  roles: Set<string>;
  phaseCounts: Record<string, number>;
  workIds: Set<string>;
  touchpoints: Map<string, MutableTouchpoint>;
  recentEvents: AgentRecentEvent[];
  authoredCount: number;
  leadCount: number;
  assignedCount: number;
  activeWorkCount: number;
  blockedWorkCount: number;
  pendingReviewCount: number;
  completedReviewCount: number;
  enrichmentPendingCount: number;
  enrichmentContributedCount: number;
  enrichmentSkippedCount: number;
  directEventCount: number;
  relatedEventCount: number;
  lastActivityAt?: string;
}

export class AgentService {
  private readonly workRepo: WorkArticleRepository;
  private readonly orchestrationRepo: OrchestrationEventRepository;
  private readonly logger: Logger;

  constructor(deps: AgentServiceDeps) {
    this.workRepo = deps.workRepo;
    this.orchestrationRepo = deps.orchestrationRepo;
    this.logger = deps.logger.child({ domain: "agents" });
  }

  async listAgents(): Promise<Result<AgentDirectory, StorageError>> {
    const directory = await this.buildDirectory();
    if (!directory.ok) return directory;

    this.logger.debug("Derived agent directory", {
      agentCount: directory.value.summary.totalAgents,
      activeAgents: directory.value.summary.activeAgents,
    });

    return directory;
  }

  async getAgent(
    id: string,
  ): Promise<Result<AgentProfile, NotFoundError | StorageError>> {
    const directory = await this.buildDirectory();
    if (!directory.ok) return directory;

    const profile = directory.value.agents.find((agent) => agent.id === id);
    if (!profile) return err(new NotFoundError("Agent", id));

    return ok(profile);
  }

  private async buildDirectory(): Promise<Result<AgentDirectory, StorageError>> {
    const [workResult, recentEventsResult] = await Promise.all([
      this.workRepo.findMany(),
      this.orchestrationRepo.findRecent(RECENT_EVENT_LIMIT),
    ]);

    if (!workResult.ok) return workResult;
    if (!recentEventsResult.ok) return recentEventsResult;

    const profiles = new Map<string, MutableProfile>();
    const workToAgents = new Map<string, Set<string>>();
    const workTitles = new Map<string, string>();

    const ensureProfile = (agentId: string): MutableProfile => {
      let profile = profiles.get(agentId);
      if (!profile) {
        profile = {
          id: agentId,
          roles: new Set(),
          phaseCounts: {},
          workIds: new Set(),
          touchpoints: new Map(),
          recentEvents: [],
          authoredCount: 0,
          leadCount: 0,
          assignedCount: 0,
          activeWorkCount: 0,
          blockedWorkCount: 0,
          pendingReviewCount: 0,
          completedReviewCount: 0,
          enrichmentPendingCount: 0,
          enrichmentContributedCount: 0,
          enrichmentSkippedCount: 0,
          directEventCount: 0,
          relatedEventCount: 0,
        };
        profiles.set(agentId, profile);
      }
      return profile;
    };

    for (const article of workResult.value) {
      workTitles.set(article.id, article.title);
      const participants = this.collectParticipants(article);

      for (const [agentId, participant] of participants) {
        const profile = ensureProfile(agentId);
        const touchpoint = this.ensureTouchpoint(profile, article);
        const workAgents = workToAgents.get(article.id) ?? new Set<string>();
        workAgents.add(agentId);
        workToAgents.set(article.id, workAgents);

        participant.roles.forEach((role) => touchpoint.roles.add(role));
        participant.reviewStatuses.forEach((status) => touchpoint.reviewStatuses.add(status));
        for (const enrichmentRole of participant.enrichmentRoles) {
          touchpoint.enrichmentRoles.push(enrichmentRole);
        }

        profile.roles.add("participant");
        for (const role of participant.profileRoles) {
          profile.roles.add(role);
        }
        profile.workIds.add(article.id);
        profile.phaseCounts[article.phase] = (profile.phaseCounts[article.phase] ?? 0) + 1;
        profile.lastActivityAt = maxTimestamp(profile.lastActivityAt, article.updatedAt);

        if (!TERMINAL_PHASES.has(article.phase)) {
          profile.activeWorkCount += 1;
        }
        if (article.blockedBy.length > 0) {
          profile.blockedWorkCount += 1;
        }
        if (participant.isAuthor) profile.authoredCount += 1;
        if (participant.isLead) profile.leadCount += 1;
        if (participant.isAssignee) profile.assignedCount += 1;
        profile.pendingReviewCount += participant.pendingReviewCount;
        profile.completedReviewCount += participant.completedReviewCount;
        profile.enrichmentPendingCount += participant.enrichmentPendingCount;
        profile.enrichmentContributedCount += participant.enrichmentContributedCount;
        profile.enrichmentSkippedCount += participant.enrichmentSkippedCount;
      }
    }

    for (const event of recentEventsResult.value) {
      const participantIds = new Set(workToAgents.get(event.workId) ?? []);
      if (event.agentId) participantIds.add(event.agentId);

      for (const agentId of participantIds) {
        const profile = ensureProfile(agentId);
        const direct = event.agentId === agentId;
        if (direct) {
          profile.directEventCount += 1;
        } else {
          profile.relatedEventCount += 1;
        }
        profile.lastActivityAt = maxTimestamp(profile.lastActivityAt, event.createdAt);

        if (profile.recentEvents.length < PROFILE_EVENT_LIMIT) {
          profile.recentEvents.push({
            id: event.id,
            workId: event.workId,
            workTitle: workTitles.get(event.workId),
            eventType: event.eventType,
            createdAt: event.createdAt,
            direct,
            details: event.details,
          });
        }
      }
    }

    const agents = [...profiles.values()]
      .map((profile) => finalizeProfile(profile))
      .sort(compareProfiles);

    const currentPhaseCounts: Record<string, number> = {
      planning: 0,
      enrichment: 0,
      implementation: 0,
      review: 0,
      done: 0,
      cancelled: 0,
      idle: 0,
    };

    for (const agent of agents) {
      const phase = agent.current?.phase ?? "idle";
      currentPhaseCounts[phase] = (currentPhaseCounts[phase] ?? 0) + 1;
    }

    return ok({
      generatedAt: timestamp(),
      summary: {
        totalAgents: agents.length,
        activeAgents: agents.filter((agent) => agent.status === "active").length,
        idleAgents: agents.filter((agent) => agent.status === "idle").length,
        reviewAgents: agents.filter((agent) => agent.pendingReviewCount > 0).length,
        enrichmentAgents: agents.filter((agent) => agent.enrichmentPendingCount > 0).length,
        directEventCount: agents.reduce((sum, agent) => sum + agent.directEventCount, 0),
        relatedEventCount: agents.reduce((sum, agent) => sum + agent.relatedEventCount, 0),
        currentPhaseCounts,
      },
      agents,
    });
  }

  private collectParticipants(article: WorkArticle): Map<string, {
    roles: Set<string>;
    profileRoles: Set<string>;
    reviewStatuses: Set<string>;
    enrichmentRoles: Array<{ role: string; status: string }>;
    isAuthor: boolean;
    isLead: boolean;
    isAssignee: boolean;
    pendingReviewCount: number;
    completedReviewCount: number;
    enrichmentPendingCount: number;
    enrichmentContributedCount: number;
    enrichmentSkippedCount: number;
  }> {
    const participants = new Map<string, {
      roles: Set<string>;
      profileRoles: Set<string>;
      reviewStatuses: Set<string>;
      enrichmentRoles: Array<{ role: string; status: string }>;
      isAuthor: boolean;
      isLead: boolean;
      isAssignee: boolean;
      pendingReviewCount: number;
      completedReviewCount: number;
      enrichmentPendingCount: number;
      enrichmentContributedCount: number;
      enrichmentSkippedCount: number;
    }>();

    const ensure = (agentId: string) => {
      let participant = participants.get(agentId);
      if (!participant) {
        participant = {
          roles: new Set(),
          profileRoles: new Set(),
          reviewStatuses: new Set(),
          enrichmentRoles: [],
          isAuthor: false,
          isLead: false,
          isAssignee: false,
          pendingReviewCount: 0,
          completedReviewCount: 0,
          enrichmentPendingCount: 0,
          enrichmentContributedCount: 0,
          enrichmentSkippedCount: 0,
        };
        participants.set(agentId, participant);
      }
      return participant;
    };

    const author = ensure(article.author);
    author.isAuthor = true;
    author.roles.add("author");
    author.profileRoles.add("author");

    if (article.lead) {
      const lead = ensure(article.lead);
      lead.isLead = true;
      lead.roles.add("lead");
      lead.profileRoles.add("lead");
    }

    if (article.assignee) {
      const assignee = ensure(article.assignee);
      assignee.isAssignee = true;
      assignee.roles.add("assignee");
      assignee.profileRoles.add("assignee");
    }

    for (const reviewer of article.reviewers) {
      const participant = ensure(reviewer.agentId);
      participant.roles.add("reviewer");
      participant.profileRoles.add("reviewer");
      participant.reviewStatuses.add(reviewer.status);
      if (reviewer.status === "pending") {
        participant.pendingReviewCount += 1;
      } else {
        participant.completedReviewCount += 1;
      }
    }

    for (const enrichmentRole of article.enrichmentRoles) {
      const participant = ensure(enrichmentRole.agentId);
      participant.roles.add(`enrichment:${enrichmentRole.role}`);
      participant.profileRoles.add("enrichment");
      participant.enrichmentRoles.push({
        role: enrichmentRole.role,
        status: enrichmentRole.status,
      });

      if (enrichmentRole.status === "pending") {
        participant.enrichmentPendingCount += 1;
      } else if (enrichmentRole.status === "contributed") {
        participant.enrichmentContributedCount += 1;
      } else if (enrichmentRole.status === "skipped") {
        participant.enrichmentSkippedCount += 1;
      }
    }

    return participants;
  }

  private ensureTouchpoint(profile: MutableProfile, article: WorkArticle): MutableTouchpoint {
    let touchpoint = profile.touchpoints.get(article.id);
    if (!touchpoint) {
      touchpoint = {
        workId: article.id,
        title: article.title,
        phase: article.phase,
        priority: article.priority,
        updatedAt: article.updatedAt,
        blockedByCount: article.blockedBy.length,
        roles: new Set(),
        reviewStatuses: new Set(),
        enrichmentRoles: [],
      };
      profile.touchpoints.set(article.id, touchpoint);
    }
    return touchpoint;
  }
}

function finalizeProfile(profile: MutableProfile): AgentProfile {
  const touchpoints = [...profile.touchpoints.values()]
    .map((touchpoint) => ({
      workId: touchpoint.workId,
      title: touchpoint.title,
      phase: touchpoint.phase,
      priority: touchpoint.priority,
      updatedAt: touchpoint.updatedAt,
      blockedByCount: touchpoint.blockedByCount,
      roles: [...touchpoint.roles].sort(),
      reviewStatuses: [...touchpoint.reviewStatuses].sort(),
      enrichmentRoles: touchpoint.enrichmentRoles
        .slice()
        .sort((left, right) => left.role.localeCompare(right.role)),
    }))
    .sort((left, right) => compareIso(right.updatedAt, left.updatedAt) || left.title.localeCompare(right.title));

  const currentTouchpoint = touchpoints.find((touchpoint) => !TERMINAL_PHASES.has(touchpoint.phase)) ?? touchpoints[0];

  return {
    id: profile.id,
    status: profile.activeWorkCount > 0 ? "active" : "idle",
    roles: [...profile.roles].sort(),
    workCount: profile.workIds.size,
    activeWorkCount: profile.activeWorkCount,
    blockedWorkCount: profile.blockedWorkCount,
    authoredCount: profile.authoredCount,
    leadCount: profile.leadCount,
    assignedCount: profile.assignedCount,
    pendingReviewCount: profile.pendingReviewCount,
    completedReviewCount: profile.completedReviewCount,
    enrichmentPendingCount: profile.enrichmentPendingCount,
    enrichmentContributedCount: profile.enrichmentContributedCount,
    enrichmentSkippedCount: profile.enrichmentSkippedCount,
    directEventCount: profile.directEventCount,
    relatedEventCount: profile.relatedEventCount,
    phaseCounts: profile.phaseCounts,
    lastActivityAt: profile.lastActivityAt,
    current: currentTouchpoint
      ? {
          workId: currentTouchpoint.workId,
          title: currentTouchpoint.title,
          phase: currentTouchpoint.phase,
          actionLabel: describeCurrentAction(currentTouchpoint),
          updatedAt: currentTouchpoint.updatedAt,
          roles: currentTouchpoint.roles,
        }
      : undefined,
    touchpoints,
    recentEvents: profile.recentEvents
      .slice()
      .sort((left, right) => compareIso(right.createdAt, left.createdAt)),
  };
}

function describeCurrentAction(touchpoint: AgentTouchpoint): string {
  if (touchpoint.phase === WorkPhase.REVIEW && touchpoint.roles.includes("reviewer")) {
    return "Review";
  }
  if (touchpoint.phase === WorkPhase.ENRICHMENT && touchpoint.roles.some((role) => role.startsWith("enrichment:"))) {
    return "Enrichment";
  }
  if (touchpoint.roles.includes("assignee")) {
    return touchpoint.phase.charAt(0).toUpperCase() + touchpoint.phase.slice(1);
  }
  if (touchpoint.roles.includes("lead")) {
    return "Coordination";
  }
  if (touchpoint.roles.includes("author")) {
    return "Context";
  }
  return touchpoint.phase.charAt(0).toUpperCase() + touchpoint.phase.slice(1);
}

function compareProfiles(left: AgentProfile, right: AgentProfile): number {
  return right.activeWorkCount - left.activeWorkCount
    || right.pendingReviewCount - left.pendingReviewCount
    || right.enrichmentPendingCount - left.enrichmentPendingCount
    || compareIso(right.lastActivityAt, left.lastActivityAt)
    || left.id.localeCompare(right.id);
}

function compareIso(left?: string, right?: string): number {
  const leftTime = left ? new Date(left).getTime() : 0;
  const rightTime = right ? new Date(right).getTime() : 0;
  return leftTime - rightTime;
}

function maxTimestamp(left?: string, right?: string): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return compareIso(left, right) >= 0 ? left : right;
}
