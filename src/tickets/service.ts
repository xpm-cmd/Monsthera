import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";
import * as tables from "../db/schema.js";
import type { InsightStream } from "../core/insight-stream.js";
import type { TicketQuorumConfig, GovernanceConfig } from "../core/config.js";
import { checkToolAccess } from "../trust/tiers.js";
import { getHead } from "../git/operations.js";
import {
  buildGovernanceOptions,
  evaluateTicketTransitionConsensus,
  GATED_ADVANCE_TARGET,
  GATED_TICKET_TRANSITIONS,
  type ConsensusPayload,
} from "./consensus.js";
import {
  buildTicketResolutionKnowledgeEntry,
  shouldCaptureTicketKnowledge,
} from "./knowledge-capture.js";
import {
  VALID_TRANSITIONS,
  TRANSITION_ROLES,
  type TicketStatus as TicketStatusType,
} from "../../schemas/ticket.js";
import type { RoleId } from "../../schemas/agent.js";
import type { TrustTier } from "../../schemas/evidence-bundle.js";
import { recordDashboardEvent } from "../dashboard/events.js";
import type { CoordinationBus } from "../coordination/bus.js";

type DB = BetterSQLite3Database<typeof schema>;

interface TicketServiceBaseContext {
  db: DB;
  repoId: number;
  repoPath: string;
  insight: Pick<InsightStream, "info" | "warn">;
  ticketQuorum?: TicketQuorumConfig;
  governance?: GovernanceConfig;
  bus?: CoordinationBus;
  refreshTicketSearch?: () => void;
  refreshKnowledgeSearch?: (knowledgeIds?: number[]) => void;
  lifecycle?: import("./lifecycle.js").LifecycleHook;
}

export type TicketServiceContext = TicketServiceBaseContext;

export interface TicketSystemContext extends TicketServiceBaseContext {
  system: true;
  actorLabel?: string;
}

export type TicketContext = TicketServiceContext | TicketSystemContext;

export interface TicketServiceError {
  ok: false;
  code: "invalid_actor" | "denied" | "not_found" | "invalid_request";
  message: string;
  data?: Record<string, unknown>;
}

export interface TicketServiceSuccess<T> {
  ok: true;
  data: T;
}

export type TicketServiceResult<T> = TicketServiceSuccess<T> | TicketServiceError;

interface ResolvedTicketActor {
  agentId: string;
  sessionId: string;
  role: RoleId;
  trustTier: TrustTier;
}

interface TicketAgentInput {
  agentId: string;
  sessionId: string;
}

interface TicketSystemInput {
  actorLabel?: string;
}

type TicketActorInput = TicketAgentInput | TicketSystemInput;
type TicketToolName =
  | "create_ticket"
  | "assign_ticket"
  | "update_ticket_status"
  | "comment_ticket"
  | "link_tickets"
  | "unlink_tickets";

const BACKLOG_PLAN_COMMENT_HEADER_PATTERNS = [
  /^\[technical analysis\]/i,
  /^\[plan iteration\]/i,
  /^\[plan review\]/i,
] as const;

const RESOLUTION_VERIFICATION_COMMENT_HEADER_PATTERNS = [
  /^\[verification\]/i,
  /^verified\b/i,
  /^verification\b/i,
  /^validated\b/i,
  /^validation\b/i,
  /^tested\b/i,
] as const;

interface BacklogPlanningReadiness {
  enforced: boolean;
  ready: boolean;
  cycleStartedAt: string;
  iterationCount: number;
  minIterations: number;
  distinctModels: number;
  requiredDistinctModels: number;
  acceptedHeaders: string[];
  eligibleComments: Array<{
    agentId: string;
    createdAt: string;
    modelKey: string | null;
  }>;
}

interface ResolutionVerificationReadiness {
  ready: boolean;
  readyForCommitAt: string;
  acceptedHeaders: string[];
  eligibleComments: Array<{
    agentId: string;
    createdAt: string;
    content: string;
  }>;
}

interface CreateTicketFields {
  title: string;
  description: string;
  severity: string;
  priority: number;
  tags: string[];
  affectedPaths: string[];
  acceptanceCriteria?: string | null;
}

export type CreateTicketInput = CreateTicketFields & TicketActorInput;

interface AssignTicketFields {
  ticketId: string;
  assigneeAgentId: string | null;
}

export type AssignTicketInput = AssignTicketFields & TicketActorInput;

interface UpdateTicketStatusFields {
  ticketId: string;
  status: TicketStatusType;
  comment?: string | null;
  autoAssign?: boolean;
  skipKnowledgeCapture?: boolean;
  commitSha?: string | null;
  commitShas?: string[] | null;
}

export type UpdateTicketStatusInput = UpdateTicketStatusFields & TicketActorInput;

interface UpdateTicketStatusOptions {
  deferKnowledgeSearchRefresh?: boolean;
}

interface CommentTicketFields {
  ticketId: string;
  content: string;
}

export type CommentTicketInput = CommentTicketFields & TicketActorInput;

interface BatchTransitionTicketsFields {
  ticketIds: string[];
  toStatus: TicketStatusType;
  comment?: string | null;
}

export type BatchTransitionTicketsInput = BatchTransitionTicketsFields & TicketActorInput;

interface BatchCommentTicketsFields {
  ticketIds: string[];
  content: string;
}

export type BatchCommentTicketsInput = BatchCommentTicketsFields & TicketActorInput;

export interface BatchItemResult {
  ticketId: string;
  ok: boolean;
  error?: string;
}

export interface BatchResult {
  ok: boolean;
  total: number;
  succeeded: number;
  failed: number;
  results: BatchItemResult[];
}

export async function createTicketRecord(
  ctx: TicketContext,
  input: CreateTicketInput,
): Promise<TicketServiceResult<Record<string, unknown>>> {
  const auth = authorizeTicketActor(ctx, input, "create_ticket");
  if (!auth.ok) return auth;
  const resolved = auth.data;

  const now = new Date().toISOString();
  const ticketId = `TKT-${randomUUID().slice(0, 8)}`;
  const commitSha = await getHead({ cwd: ctx.repoPath });

  const ticket = ctx.db.transaction((tx) => {
    const createdTicket = tx.insert(tables.tickets).values({
      repoId: ctx.repoId,
      ticketId,
      title: input.title,
      description: input.description,
      status: "backlog",
      severity: input.severity,
      priority: input.priority,
      tagsJson: JSON.stringify(input.tags),
      affectedPathsJson: JSON.stringify(input.affectedPaths),
      acceptanceCriteria: input.acceptanceCriteria ?? null,
      creatorAgentId: resolved.agentId,
      creatorSessionId: resolved.sessionId,
      commitSha,
      createdAt: now,
      updatedAt: now,
    }).returning().get();

    tx.insert(tables.ticketHistory).values({
      ticketId: createdTicket.id,
      fromStatus: null,
      toStatus: "backlog",
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      comment: "Ticket created",
      timestamp: now,
    }).run();

    return createdTicket;
  });
  refreshTicketSearch(ctx);

  ctx.insight.info(`Ticket ${ticketId} created by ${resolved.agentId}`);
  recordDashboardEvent(ctx.db, ctx.repoId, {
    type: "ticket_created",
    data: { ticketId, status: "backlog", severity: input.severity, creatorAgentId: resolved.agentId },
  });
  broadcastTicketRealtime(ctx, resolved.agentId, "ticket_created", {
    ticketId,
    status: "backlog",
    severity: input.severity,
    creatorAgentId: resolved.agentId,
  });

  ctx.lifecycle?.onTicketCreated({
    ticketId,
    severity: input.severity,
    priority: input.priority,
  });

  return ok({
    ticketId,
    title: input.title,
    status: "backlog",
    severity: input.severity,
    priority: input.priority,
    commitSha,
  });
}

export function assignTicketRecord(
  ctx: TicketContext,
  input: AssignTicketInput,
): TicketServiceResult<Record<string, unknown>> {
  const auth = authorizeTicketActor(ctx, input, "assign_ticket");
  if (!auth.ok) return auth;
  const resolved = auth.data;

  const ticket = queries.getTicketByTicketId(ctx.db, input.ticketId, ctx.repoId);
  if (!ticket) return err("not_found", `Ticket not found: ${input.ticketId}`);

  if (input.assigneeAgentId === null) {
    if (resolved.role === "developer") {
      return err("denied", "Developers cannot clear ticket assignees");
    }
    if (!ticket.assigneeAgentId) {
      return err("invalid_request", "Ticket has no assignee to clear");
    }

    queries.updateTicket(ctx.db, ticket.id, { assigneeAgentId: null });
    refreshTicketSearch(ctx);

    ctx.insight.info(`Ticket ${input.ticketId} assignee cleared by ${resolved.agentId}`);
    recordDashboardEvent(ctx.db, ctx.repoId, {
      type: "ticket_unassigned",
      data: {
        ticketId: input.ticketId,
        previousAssigneeAgentId: ticket.assigneeAgentId,
        status: ticket.status,
        agentId: resolved.agentId,
      },
    });
    broadcastTicketRealtime(ctx, resolved.agentId, "ticket_unassigned", {
      ticketId: input.ticketId,
      previousAssigneeAgentId: ticket.assigneeAgentId,
      status: ticket.status,
    });

    return ok({
      ticketId: input.ticketId,
      assigneeAgentId: null,
      status: ticket.status,
    });
  }

  if (resolved.role === "developer") {
    if (input.assigneeAgentId !== resolved.agentId) {
      return err("denied", "Developers can only self-assign tickets");
    }
    if (!["backlog", "technical_analysis", "approved"].includes(ticket.status)) {
      return err("invalid_request", "Developers can only assign tickets in backlog, technical_analysis, or approved status");
    }
    if (ticket.assigneeAgentId && ticket.assigneeAgentId !== resolved.agentId) {
      return err("denied", "Developers cannot reassign tickets already owned by another agent");
    }
  }

  if (!queries.getAgent(ctx.db, input.assigneeAgentId)) {
    return err("not_found", `Assignee not found: ${input.assigneeAgentId}`);
  }

  const updates: Partial<Pick<typeof tables.tickets.$inferInsert, "assigneeAgentId">> = {
    assigneeAgentId: input.assigneeAgentId,
  };

  queries.updateTicket(ctx.db, ticket.id, updates);
  refreshTicketSearch(ctx);

  ctx.insight.info(`Ticket ${input.ticketId} assigned to ${input.assigneeAgentId} by ${resolved.agentId}`);
  recordDashboardEvent(ctx.db, ctx.repoId, {
    type: "ticket_assigned",
    data: {
      ticketId: input.ticketId,
      assigneeAgentId: input.assigneeAgentId,
      status: ticket.status,
      agentId: resolved.agentId,
    },
  });
  broadcastTicketRealtime(ctx, resolved.agentId, "ticket_assigned", {
    ticketId: input.ticketId,
    assigneeAgentId: input.assigneeAgentId,
    status: ticket.status,
  });

  return ok({
    ticketId: input.ticketId,
    assigneeAgentId: input.assigneeAgentId,
    status: ticket.status,
  });
}

export function updateTicketStatusRecord(
  ctx: TicketContext,
  input: UpdateTicketStatusInput,
  options?: UpdateTicketStatusOptions,
): TicketServiceResult<Record<string, unknown>> {
  const auth = authorizeTicketActor(ctx, input, "update_ticket_status");
  if (!auth.ok) return auth;
  const resolved = auth.data;

  const ticket = queries.getTicketByTicketId(ctx.db, input.ticketId, ctx.repoId);
  if (!ticket) return err("not_found", `Ticket not found: ${input.ticketId}`);

  const current = ticket.status as TicketStatusType;
  const validTargets = VALID_TRANSITIONS[current];
  if (!validTargets?.includes(input.status)) {
    return err("invalid_request", `Invalid transition: ${current} → ${input.status}`, {
      validTransitions: validTargets,
    });
  }

  let nextAssigneeAgentId = ticket.assigneeAgentId ?? null;
  const isSystemActor = resolved.agentId.startsWith("system:");
  const willAutoAssign = input.status === "in_progress"
    && !nextAssigneeAgentId
    && input.autoAssign === true
    && !isSystemActor;

  if (willAutoAssign) {
    nextAssigneeAgentId = resolved.agentId;
  }

  if (input.status === "in_progress" && !nextAssigneeAgentId) {
    return err(
      "invalid_request",
      "Cannot move to in_progress without an assignee. Use assign_ticket first, or retry with autoAssign=true from a non-system actor.",
      {
        ticketId: input.ticketId,
        transition: `${current}→${input.status}`,
        assigneeAgentId: ticket.assigneeAgentId,
        autoAssignAllowed: !isSystemActor,
      },
    );
  }

  if (resolved.role === "developer" && nextAssigneeAgentId !== resolved.agentId) {
    return err("denied", "Developers can only transition tickets assigned to themselves");
  }

  // Resolution governance: resolver must be assignee or have elevated role
  if (input.status === "resolved" && ticket.assigneeAgentId && !isSystemActor) {
    const isAssignee = ticket.assigneeAgentId === resolved.agentId;
    const isElevated = resolved.role === "facilitator" || resolved.role === "admin";
    if (!isAssignee && !isElevated) {
      return err("denied",
        `Only the assignee (${ticket.assigneeAgentId}) or a facilitator/admin can resolve this ticket.`);
    }
    if (!isAssignee && isElevated && !input.comment?.trim()) {
      return err("invalid_request",
        `Resolver differs from assignee (${ticket.assigneeAgentId}). A justification comment is required when resolving on behalf of another agent.`);
    }
  }

  const key = `${current}→${input.status}`;

  // Require at least 1 ticket comment before resolving from ready_for_commit
  if (input.status === "resolved" && current === "ready_for_commit" && !isSystemActor) {
    const verificationReadiness = evaluateResolutionVerificationReadiness(
      ctx.db,
      ticket.id,
      ticket.createdAt,
    );
    if (!verificationReadiness.ready) {
      return err("invalid_request",
        buildResolutionVerificationBlockMessage(key, verificationReadiness),
        {
          transition: key,
          readyForCommitAt: verificationReadiness.readyForCommitAt,
          acceptedHeaders: verificationReadiness.acceptedHeaders,
          eligibleComments: verificationReadiness.eligibleComments,
        },
      );
    }
  }

  const allowed = TRANSITION_ROLES[key];
  if (allowed && !allowed.includes(resolved.role)) {
    ctx.insight.warn(
      `Advisory: ${resolved.role} triggering ${key} (recommended: ${allowed.join(", ")})`,
    );
  }

  const backlogPlanning = current === "backlog" && input.status === "technical_analysis"
    ? evaluateBacklogPlanningReadiness(ctx.db, ticket.id, ticket.createdAt, ctx.governance)
    : null;
  if (backlogPlanning?.enforced && !backlogPlanning.ready) {
    return err(
      "invalid_request",
      buildBacklogPlanningBlockMessage(key, backlogPlanning),
      {
        transition: key,
        cycleStartedAt: backlogPlanning.cycleStartedAt,
        iterationCount: backlogPlanning.iterationCount,
        minIterations: backlogPlanning.minIterations,
        distinctModels: backlogPlanning.distinctModels,
        requiredDistinctModels: backlogPlanning.requiredDistinctModels,
        acceptedHeaders: backlogPlanning.acceptedHeaders,
        eligibleComments: backlogPlanning.eligibleComments,
      },
    );
  }

  if (resolved.role !== "admin") {
    const isGated = (GATED_TICKET_TRANSITIONS as readonly string[]).includes(`${current}→${input.status}`);
    const verdictRows = isGated ? queries.getActiveReviewVerdicts(ctx.db, ticket.id) : [];
    const governanceOpts = isGated
      ? buildGovernanceOptions(ctx.governance, verdictRows, (agentId) => {
          const agent = queries.getAgent(ctx.db, agentId);
          return agent ? { roleId: agent.roleId, provider: agent.provider, model: agent.model } : undefined;
        }, ticket.severity)
      : undefined;
    const consensus = isGated
      ? evaluateTicketTransitionConsensus({
          ticketId: input.ticketId,
          fromStatus: current,
          toStatus: input.status,
          verdictRows,
          config: ctx.ticketQuorum,
          governance: governanceOpts,
        })
      : null;
    if (consensus && !consensus.advisoryReady) {
      return err(
        "invalid_request",
        buildConsensusBlockMessage(key, consensus),
        {
          transition: consensus.transition,
          requiredPasses: consensus.requiredPasses,
          counts: consensus.counts,
          passesNeeded: Math.max(0, consensus.requiredPasses - consensus.counts.pass),
          quorumMet: consensus.quorumMet,
          blockedByVeto: consensus.blockedByVeto,
          councilSpecializations: consensus.councilSpecializations,
          vetoSpecializations: consensus.vetoSpecializations,
          missingSpecializations: consensus.missingSpecializations,
          vetoes: consensus.vetoes,
          verdicts: consensus.verdicts,
        },
      );
    }
  }

  const now = new Date().toISOString();
  const linkedPatches = queries.getPatchesByTicketId(ctx.db, ticket.id);
  const resolutionCommitShas = input.status === "resolved"
    ? deriveResolutionCommitShas(ctx.db, ctx.repoId, ticket.ticketId, {
        comment: input.comment ?? null,
        linkedPatches,
        commitSha: input.commitSha ?? null,
        commitShas: input.commitShas ?? null,
      })
    : [];
  const captureTargetStatus = shouldCaptureTicketKnowledge(input.status) ? input.status : null;
  const knowledgeEntry = captureTargetStatus && input.skipKnowledgeCapture !== true
    ? buildTicketResolutionKnowledgeEntry({
        ticket,
        targetStatus: captureTargetStatus,
        transitionComment: input.comment ?? null,
        actorAgentId: resolved.agentId,
        actorSessionId: resolved.sessionId,
        capturedAt: now,
        history: queries.getTicketHistory(ctx.db, ticket.id),
        comments: queries.getTicketComments(ctx.db, ticket.id),
        linkedPatches,
      })
    : null;
  const resolvedCommitSha = resolutionCommitShas[0] ?? input.commitSha?.trim() ?? null;

  // Shared SHA warning: warn if this commit is already associated with other resolved tickets
  let sharedCommitWarning: string | null = null;
  const effectiveCommitSha = resolvedCommitSha ?? ticket.commitSha;
  if (input.status === "resolved" && effectiveCommitSha && !isSystemActor) {
    const otherTickets = ctx.db.select({ ticketId: tables.tickets.ticketId })
      .from(tables.tickets)
      .where(and(
        eq(tables.tickets.repoId, ctx.repoId),
        eq(tables.tickets.status, "resolved"),
        eq(tables.tickets.commitSha, effectiveCommitSha),
        ne(tables.tickets.id, ticket.id),
      ))
      .all();
    if (otherTickets.length > 0) {
      sharedCommitWarning = `Commit ${effectiveCommitSha.slice(0, 7)} is already associated with ${otherTickets.length} other ticket(s): ${otherTickets.map((t) => t.ticketId).join(", ")}. Consider atomic commits per ticket for safe rollback.`;
      ctx.insight.warn(sharedCommitWarning);
    }
  }

  const updates: Partial<Pick<typeof tables.tickets.$inferInsert, "status" | "resolvedByAgentId" | "commitSha" | "assigneeAgentId">> = {
    status: input.status,
  };
  if (input.status === "resolved") updates.resolvedByAgentId = resolved.agentId;
  if (input.status === "resolved" && resolvedCommitSha) updates.commitSha = resolvedCommitSha;
  if (current === "resolved" && input.status === "in_progress") updates.resolvedByAgentId = null;
  if (nextAssigneeAgentId !== ticket.assigneeAgentId) updates.assigneeAgentId = nextAssigneeAgentId;
  const isEnteringGatedStatus = Object.prototype.hasOwnProperty.call(GATED_ADVANCE_TARGET, input.status);

  let knowledgeId: number | null = null;
  ctx.db.transaction((tx) => {
    tx.update(tables.tickets)
      .set({ ...updates, updatedAt: now })
      .where(eq(tables.tickets.id, ticket.id))
      .run();
    if (isEnteringGatedStatus) {
      queries.clearActiveReviewVerdicts(tx, ticket.id);
    }
    tx.insert(tables.ticketHistory).values({
      ticketId: ticket.id,
      fromStatus: current,
      toStatus: input.status,
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      comment: input.comment ?? null,
      timestamp: now,
    }).run();
    if (input.status === "resolved" || (current === "resolved" && input.status === "in_progress")) {
      queries.setTicketResolutionCommitShas(tx, ticket.id, resolutionCommitShas, now);
    }
    if (knowledgeEntry) {
      knowledgeId = queries.upsertKnowledge(tx, knowledgeEntry).id;
    }
  });
  refreshTicketSearch(ctx);
  if (knowledgeEntry && !options?.deferKnowledgeSearchRefresh) {
    refreshKnowledgeSearch(ctx, knowledgeId != null ? [knowledgeId] : undefined);
  }

  ctx.insight.info(`Ticket ${input.ticketId}: ${current} → ${input.status} by ${resolved.agentId}`);
  if (nextAssigneeAgentId !== ticket.assigneeAgentId) {
    recordDashboardEvent(ctx.db, ctx.repoId, {
      type: "ticket_assigned",
      data: {
        ticketId: input.ticketId,
        assigneeAgentId: nextAssigneeAgentId,
        status: input.status,
        agentId: resolved.agentId,
        autoAssigned: true,
      },
    });
    broadcastTicketRealtime(ctx, resolved.agentId, "ticket_assigned", {
      ticketId: input.ticketId,
      assigneeAgentId: nextAssigneeAgentId,
      status: input.status,
      autoAssigned: true,
    });
  }
  recordDashboardEvent(ctx.db, ctx.repoId, {
    type: "ticket_status_changed",
    data: {
      ticketId: input.ticketId,
      previousStatus: current,
      status: input.status,
      agentId: resolved.agentId,
    },
  });
  broadcastTicketRealtime(ctx, resolved.agentId, "ticket_status_changed", {
    ticketId: input.ticketId,
    previousStatus: current,
    status: input.status,
  });

  ctx.lifecycle?.onTicketStatusChanged({
    ticketId: input.ticketId,
    previousStatus: current,
    status: input.status,
    actorLabel: resolved.agentId,
  });

  // Rate-limit audit: warn if agent resolves >3 tickets in 1 hour (non-blocking)
  let resolutionRateWarning: string | null = null;
  if (input.status === "resolved" && !isSystemActor) {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const recentResolutions = ctx.db.select()
      .from(tables.ticketHistory)
      .where(eq(tables.ticketHistory.toStatus, "resolved"))
      .all()
      .filter((row) => row.agentId === resolved.agentId && row.timestamp >= oneHourAgo);
    if (recentResolutions.length > 3) {
      resolutionRateWarning = `Audit notice: ${resolved.agentId} has resolved ${recentResolutions.length} tickets in the last hour.`;
      ctx.insight.warn(resolutionRateWarning);
    }
  }

  return ok({
    ticketId: input.ticketId,
    previousStatus: current,
    status: input.status,
    assigneeAgentId: nextAssigneeAgentId,
    knowledgeCaptured: Boolean(knowledgeEntry),
    knowledgeKey: knowledgeEntry?.key ?? null,
    ...(resolutionRateWarning ? { resolutionRateWarning } : {}),
    ...(sharedCommitWarning ? { sharedCommitWarning } : {}),
  });
}

export function commentTicketRecord(
  ctx: TicketContext,
  input: CommentTicketInput,
): TicketServiceResult<Record<string, unknown>> {
  const auth = authorizeTicketActor(ctx, input, "comment_ticket");
  if (!auth.ok) return auth;
  const resolved = auth.data;

  const ticket = queries.getTicketByTicketId(ctx.db, input.ticketId, ctx.repoId);
  if (!ticket) return err("not_found", `Ticket not found: ${input.ticketId}`);

  const now = new Date().toISOString();
  const comment = ctx.db.transaction((tx) => {
    tx.update(tables.tickets)
      .set({ updatedAt: now })
      .where(eq(tables.tickets.id, ticket.id))
      .run();

    return tx.insert(tables.ticketComments).values({
      ticketId: ticket.id,
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      content: input.content,
      createdAt: now,
    }).returning().get();
  });

  recordDashboardEvent(ctx.db, ctx.repoId, {
    type: "ticket_commented",
    data: { ticketId: input.ticketId, commentId: comment.id, agentId: resolved.agentId },
  });
  broadcastTicketRealtime(ctx, resolved.agentId, "ticket_commented", {
    ticketId: input.ticketId,
    commentId: comment.id,
    agentId: resolved.agentId,
  });

  return ok({
    ticketId: input.ticketId,
    commentId: comment.id,
    agentId: resolved.agentId,
    content: input.content,
    createdAt: now,
  });
}

// --- Batch Operations ---

export function batchTransitionTickets(
  ctx: TicketContext,
  input: BatchTransitionTicketsInput,
): TicketServiceResult<BatchResult> {
  const ticketIds = normalizeBatchTicketIds(input.ticketIds);
  if (ticketIds.length === 0) {
    return err("invalid_request", "At least one ticketId is required");
  }

  const results: BatchItemResult[] = [];
  let needsKnowledgeRefresh = false;
  for (const ticketId of ticketIds) {
    const update = updateTicketStatusRecord(ctx, {
      ...copyTicketActorInput(input),
      ticketId,
      status: input.toStatus,
      comment: input.comment,
    }, {
      deferKnowledgeSearchRefresh: true,
    });
    if (update.ok) {
      results.push({ ticketId, ok: true });
      if (update.data.knowledgeCaptured === true) {
        needsKnowledgeRefresh = true;
      }
    } else {
      results.push({ ticketId, ok: false, error: update.message });
    }
  }

  if (needsKnowledgeRefresh) {
    refreshKnowledgeSearch(ctx);
  }

  const succeeded = results.filter((r) => r.ok).length;
  return ok({
    ok: succeeded === results.length,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  });
}

export function batchCommentTickets(
  ctx: TicketContext,
  input: BatchCommentTicketsInput,
): TicketServiceResult<BatchResult> {
  const ticketIds = normalizeBatchTicketIds(input.ticketIds);
  if (ticketIds.length === 0) {
    return err("invalid_request", "At least one ticketId is required");
  }

  const results: BatchItemResult[] = [];
  for (const ticketId of ticketIds) {
    const comment = commentTicketRecord(ctx, {
      ...copyTicketActorInput(input),
      ticketId,
      content: input.content,
    });
    if (comment.ok) {
      results.push({ ticketId, ok: true });
    } else {
      results.push({ ticketId, ok: false, error: comment.message });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  return ok({
    ok: succeeded === results.length,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  });
}

// --- Ticket Dependencies ---

interface LinkTicketsFields {
  fromTicketId: string; // TKT-... (the blocker)
  toTicketId: string;   // TKT-... (the blocked)
  relationType: "blocks" | "relates_to";
}

type LinkTicketsInput = LinkTicketsFields & TicketActorInput;

export function linkTicketsRecord(
  ctx: TicketContext,
  input: LinkTicketsInput,
): TicketServiceResult<Record<string, unknown>> {
  const auth = authorizeTicketActor(ctx, input, "link_tickets");
  if (!auth.ok) return auth;
  const resolved = auth.data;

  const fromTicket = queries.getTicketByTicketId(ctx.db, input.fromTicketId, ctx.repoId);
  if (!fromTicket) return err("not_found", `Ticket not found: ${input.fromTicketId}`);

  const toTicket = queries.getTicketByTicketId(ctx.db, input.toTicketId, ctx.repoId);
  if (!toTicket) return err("not_found", `Ticket not found: ${input.toTicketId}`);

  if (fromTicket.id === toTicket.id) return err("invalid_request", "Cannot link a ticket to itself");

  // For "blocks", validate DAG (no cycles)
  if (input.relationType === "blocks") {
    const edges = queries.getAllBlocksEdges(ctx.db);
    // Add proposed edge and check for cycle
    const proposed = { fromTicketId: fromTicket.id, toTicketId: toTicket.id };
    if (wouldCreateCycle(edges, proposed)) {
      return err("invalid_request", `Adding ${input.fromTicketId} blocks ${input.toTicketId} would create a cycle`);
    }
  }

  const now = new Date().toISOString();
  const dep = queries.createTicketDependency(ctx.db, {
    fromTicketId: fromTicket.id,
    toTicketId: toTicket.id,
    relationType: input.relationType,
    createdByAgentId: resolved.agentId,
    createdAt: now,
  });

  recordDashboardEvent(ctx.db, ctx.repoId, {
    type: "ticket_linked",
    data: { fromTicketId: input.fromTicketId, toTicketId: input.toTicketId, relationType: input.relationType },
  });

  return ok({
    id: dep.id,
    fromTicketId: input.fromTicketId,
    toTicketId: input.toTicketId,
    relationType: input.relationType,
  });
}

interface UnlinkTicketsFields {
  fromTicketId: string;
  toTicketId: string;
}

type UnlinkTicketsInput = UnlinkTicketsFields & TicketActorInput;

export function unlinkTicketsRecord(
  ctx: TicketContext,
  input: UnlinkTicketsInput,
): TicketServiceResult<Record<string, unknown>> {
  const auth = authorizeTicketActor(ctx, input, "unlink_tickets");
  if (!auth.ok) return auth;

  const fromTicket = queries.getTicketByTicketId(ctx.db, input.fromTicketId, ctx.repoId);
  if (!fromTicket) return err("not_found", `Ticket not found: ${input.fromTicketId}`);

  const toTicket = queries.getTicketByTicketId(ctx.db, input.toTicketId, ctx.repoId);
  if (!toTicket) return err("not_found", `Ticket not found: ${input.toTicketId}`);

  queries.deleteTicketDependency(ctx.db, fromTicket.id, toTicket.id);

  return ok({
    fromTicketId: input.fromTicketId,
    toTicketId: input.toTicketId,
    unlinked: true,
  });
}

/** BFS cycle detection: would adding (from→to) create a cycle in the blocks DAG? */
function wouldCreateCycle(
  edges: { fromTicketId: number; toTicketId: number }[],
  proposed: { fromTicketId: number; toTicketId: number },
): boolean {
  // A cycle exists if we can reach proposed.fromTicketId starting from proposed.toTicketId
  const adj = new Map<number, number[]>();
  for (const e of edges) {
    const list = adj.get(e.fromTicketId) ?? [];
    list.push(e.toTicketId);
    adj.set(e.fromTicketId, list);
  }
  // Add proposed edge
  const list = adj.get(proposed.fromTicketId) ?? [];
  list.push(proposed.toTicketId);
  adj.set(proposed.fromTicketId, list);

  // BFS from proposed.toTicketId — can we reach proposed.fromTicketId?
  const visited = new Set<number>();
  const queue = [proposed.toTicketId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === proposed.fromTicketId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adj.get(current) ?? []) {
      queue.push(next);
    }
  }
  return false;
}

const TICKET_ID_PATTERN = /\bTKT-[A-Za-z0-9]+\b/gi;

function deriveResolutionCommitShas(
  db: DB,
  repoId: number,
  ticketId: string,
  input: {
    comment?: string | null;
    linkedPatches: ReturnType<typeof queries.getPatchesByTicketId>;
    commitSha?: string | null;
    commitShas?: readonly string[] | null;
  },
): string[] {
  const seen = new Set<string>();
  const commitShas: string[] = [];
  const push = (value: string | null | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    commitShas.push(trimmed);
  };

  for (const patch of input.linkedPatches) {
    push(patch.committedSha);
  }

  for (const referencedTicketId of extractReferencedTicketIds(input.comment ?? null)) {
    if (referencedTicketId.toLowerCase() === ticketId.toLowerCase()) continue;
    const referencedTicket = queries.getTicketByTicketId(db, referencedTicketId, repoId);
    if (!referencedTicket) continue;

    const referencedResolutionCommitShas = queries.getTicketResolutionCommitShas(db, referencedTicket.id);
    if (referencedResolutionCommitShas.length > 0) {
      for (const referencedCommitSha of referencedResolutionCommitShas) {
        push(referencedCommitSha);
      }
      continue;
    }

    push(referencedTicket.commitSha);
  }

  for (const explicitCommitSha of input.commitShas ?? []) {
    push(explicitCommitSha);
  }
  push(input.commitSha);

  return commitShas;
}

function extractReferencedTicketIds(text: string | null): string[] {
  if (!text) return [];

  const seen = new Set<string>();
  const ticketIds: string[] = [];
  const matches = text.match(TICKET_ID_PATTERN) ?? [];
  for (const match of matches) {
    const normalized = `TKT-${match.slice(4).toLowerCase()}`;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    ticketIds.push(normalized);
  }
  return ticketIds;
}

function isSystemContext(ctx: TicketContext): ctx is TicketSystemContext {
  return "system" in ctx && ctx.system === true;
}

function authorizeTicketActor(
  ctx: TicketContext,
  input: TicketActorInput,
  tool: TicketToolName,
): TicketServiceResult<ResolvedTicketActor> {
  const resolved = isSystemContext(ctx)
    ? resolveSystemTicketActor(ctx, input)
    : resolveRegisteredTicketActor(
        ctx.db,
        "agentId" in input ? input.agentId : undefined,
        "sessionId" in input ? input.sessionId : undefined,
      );

  if (!resolved) {
    return err("invalid_actor", "Agent or session not found / inactive");
  }

  const access = checkToolAccess(tool, resolved.role, resolved.trustTier);
  if (!access.allowed) return err("denied", access.reason, { denied: true });

  return ok(resolved);
}

function resolveRegisteredTicketActor(
  db: DB,
  agentId?: string,
  sessionId?: string,
): ResolvedTicketActor | null {
  if (!agentId || !sessionId) return null;

  const agent = queries.getAgent(db, agentId);
  if (!agent) return null;

  const session = queries.getSession(db, sessionId);
  if (!session || session.agentId !== agentId || session.state !== "active") return null;

  queries.updateSessionActivity(db, session.id);

  return {
    agentId: agent.id,
    sessionId: session.id,
    role: agent.roleId as RoleId,
    trustTier: agent.trustTier as TrustTier,
  };
}

function resolveSystemTicketActor(
  ctx: TicketSystemContext,
  input: TicketActorInput,
): ResolvedTicketActor {
  const rawLabel = ("actorLabel" in input ? input.actorLabel : undefined) ?? ctx.actorLabel ?? "service";
  const label = normalizeSystemActorLabel(rawLabel);
  return {
    agentId: `system:${label}`,
    sessionId: "system",
    role: "admin",
    trustTier: "A",
  };
}

function normalizeSystemActorLabel(label: string): string {
  const normalized = label.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "service";
}

function copyTicketActorInput(input: TicketActorInput): TicketActorInput {
  return "agentId" in input
    ? { agentId: input.agentId, sessionId: input.sessionId }
    : { actorLabel: input.actorLabel };
}

function normalizeBatchTicketIds(ticketIds: string[]): string[] {
  return [...new Set(ticketIds.map((ticketId) => ticketId.trim()).filter(Boolean))];
}

function ok<T>(data: T): TicketServiceSuccess<T> {
  return { ok: true, data };
}

function broadcastTicketRealtime(
  ctx: TicketContext,
  agentId: string,
  eventType: "ticket_created" | "ticket_assigned" | "ticket_unassigned" | "ticket_status_changed" | "ticket_commented" | "ticket_linked",
  data: Record<string, unknown>,
): void {
  ctx.bus?.send({
    from: agentId,
    to: null,
    type: "status_update",
    payload: {
      domain: "ticket",
      eventType,
      ...data,
    },
  });
}

function refreshTicketSearch(ctx: TicketContext): void {
  try {
    ctx.refreshTicketSearch?.();
  } catch (error) {
    ctx.insight.warn(`Ticket search refresh failed: ${error}`);
  }
}

function refreshKnowledgeSearch(ctx: TicketContext, knowledgeIds?: number[]): void {
  try {
    ctx.refreshKnowledgeSearch?.(knowledgeIds);
  } catch (error) {
    ctx.insight.warn(`Knowledge search refresh failed: ${error}`);
  }
}

function err(
  code: TicketServiceError["code"],
  message: string,
  data?: Record<string, unknown>,
): TicketServiceError {
  return { ok: false, code, message, data };
}

function buildConsensusBlockMessage(
  transitionKey: string,
  consensus: ConsensusPayload,
): string {
  const reviewerIndependence = consensus.governance?.reviewerIndependence;
  if (consensus.governance?.strictReviewerIndependenceApplied && reviewerIndependence && !reviewerIndependence.independenceMet) {
    const duplicateSummary = reviewerIndependence.duplicateGroups
      .map((group) => `${group.agentIds.join(", ")} covering ${group.specializations.join(", ")}`)
      .join("; ");
    return `Reviewer independence not met for ${transitionKey}: ${duplicateSummary}. Require distinct reviewer identities or use an explicit admin override.`;
  }

  if (consensus.blockedByVeto) {
    const vetoSummary = consensus.vetoes
      .map((veto) => {
        const reason = veto.reasoning?.trim();
        return reason
          ? `${veto.specialization} by ${veto.agentId}: ${reason}`
          : `${veto.specialization} by ${veto.agentId}`;
      })
      .join("; ");
    return `Council veto blocks ${transitionKey}: ${vetoSummary}. Submit updated verdicts to clear the veto.`;
  }

  const modelDiversity = consensus.governance?.modelDiversity;
  if (consensus.governance?.modelVoterCapApplied && modelDiversity && !modelDiversity.voterCapMet) {
    const overSubscribed = modelDiversity.overSubscribedGroups
      .map((group) => `${group.provider}/${group.model} has ${group.totalVoters} voters (max ${group.maxVoters})`)
      .join("; ");
    return `Reviewer model cap not met for ${transitionKey}: ${overSubscribed}. Reduce same-model reviewers to continue or use an explicit admin override.`;
  }

  if (consensus.governance?.strictDiversityApplied && modelDiversity && !modelDiversity.diversityMet) {
    const duplicateModels = modelDiversity.duplicateGroups
      .map((group) => `${group.provider}/${group.model} covering ${group.specializations.join(", ")}`)
      .join("; ");
    return `Reviewer model diversity not met for ${transitionKey}: ${duplicateModels}. Require distinct reviewer models or use an explicit admin override.`;
  }

  const passesNeeded = Math.max(0, consensus.requiredPasses - consensus.counts.pass);
  const awaiting = consensus.missingSpecializations.length > 0
    ? ` Await verdicts from: ${consensus.missingSpecializations.join(", ")}.`
    : "";
  return `Council quorum not met for ${transitionKey}: ${consensus.counts.pass}/${consensus.requiredPasses} passes (${passesNeeded} more needed).${awaiting}`;
}

function buildBacklogPlanningBlockMessage(
  transitionKey: string,
  readiness: BacklogPlanningReadiness,
): string {
  return `Backlog planning gate not met for ${transitionKey}: ${readiness.iterationCount}/${readiness.minIterations} structured plan iterations and ${readiness.distinctModels}/${readiness.requiredDistinctModels} distinct models since ${readiness.cycleStartedAt}. Add ticket comments starting with ${readiness.acceptedHeaders.join(", ")} before leaving backlog.`;
}

function buildResolutionVerificationBlockMessage(
  transitionKey: string,
  readiness: ResolutionVerificationReadiness,
): string {
  return `Verification evidence not met for ${transitionKey}: add a ticket comment after ${readiness.readyForCommitAt} starting with ${readiness.acceptedHeaders.join(", ")} to document what was verified before resolving.`;
}

function evaluateBacklogPlanningReadiness(
  db: DB,
  ticketInternalId: number,
  ticketCreatedAt: string,
  governance?: GovernanceConfig,
): BacklogPlanningReadiness | null {
  const gate = governance?.backlogPlanningGate;
  if (!gate?.enforce) return null;

  const history = queries.getTicketHistory(db, ticketInternalId);
  const cycleStartedAt = [...history]
    .reverse()
    .find((entry) => entry.toStatus === "backlog")
    ?.timestamp ?? ticketCreatedAt;

  const acceptedHeaders = ["[Technical Analysis]", "[Plan Iteration]", "[Plan Review]"];
  const eligibleComments = queries.getTicketComments(db, ticketInternalId)
    .filter((comment) => (
      comment.createdAt >= cycleStartedAt
      && BACKLOG_PLAN_COMMENT_HEADER_PATTERNS.some((pattern) => pattern.test(comment.content.trim()))
    ))
    .map((comment) => {
      const agent = queries.getAgent(db, comment.agentId);
      const modelKey = agent?.provider && agent.model ? `${agent.provider}/${agent.model}` : null;
      return {
        agentId: comment.agentId,
        createdAt: comment.createdAt,
        modelKey,
      };
    });

  const distinctModels = new Set(
    eligibleComments
      .map((comment) => comment.modelKey)
      .filter((modelKey): modelKey is string => Boolean(modelKey)),
  ).size;

  return {
    enforced: true,
    ready: eligibleComments.length >= gate.minIterations && distinctModels >= gate.requiredDistinctModels,
    cycleStartedAt,
    iterationCount: eligibleComments.length,
    minIterations: gate.minIterations,
    distinctModels,
    requiredDistinctModels: gate.requiredDistinctModels,
    acceptedHeaders,
    eligibleComments,
  };
}

function evaluateResolutionVerificationReadiness(
  db: DB,
  ticketInternalId: number,
  ticketCreatedAt: string,
): ResolutionVerificationReadiness {
  const history = queries.getTicketHistory(db, ticketInternalId);
  const readyForCommitAt = [...history]
    .reverse()
    .find((entry) => entry.toStatus === "ready_for_commit")
    ?.timestamp ?? ticketCreatedAt;

  const acceptedHeaders = ["[Verification]", "Verified", "Verification", "Validated", "Tested"];
  const eligibleComments = queries.getTicketComments(db, ticketInternalId)
    .filter((comment) => (
      comment.createdAt >= readyForCommitAt
      && RESOLUTION_VERIFICATION_COMMENT_HEADER_PATTERNS.some((pattern) => pattern.test(comment.content.trim()))
    ))
    .map((comment) => ({
      agentId: comment.agentId,
      createdAt: comment.createdAt,
      content: comment.content,
    }));

  return {
    ready: eligibleComments.length > 0,
    readyForCommitAt,
    acceptedHeaders,
    eligibleComments,
  };
}
