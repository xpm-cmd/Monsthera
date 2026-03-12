import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";
import * as tables from "../db/schema.js";
import type { InsightStream } from "../core/insight-stream.js";
import type { TicketQuorumConfig } from "../core/config.js";
import { checkToolAccess } from "../trust/tiers.js";
import { getHead } from "../git/operations.js";
import {
  evaluateTicketTransitionConsensus,
  resolveTicketQuorumRule,
  type TransitionConsensusPayload,
} from "./consensus.js";
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
  bus?: CoordinationBus;
  refreshTicketSearch?: () => void;
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
  assigneeAgentId: string;
}

export type AssignTicketInput = AssignTicketFields & TicketActorInput;

interface UpdateTicketStatusFields {
  ticketId: string;
  status: TicketStatusType;
  comment?: string | null;
}

export type UpdateTicketStatusInput = UpdateTicketStatusFields & TicketActorInput;

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
): TicketServiceResult<Record<string, unknown>> {
  const auth = authorizeTicketActor(ctx, input, "update_ticket_status");
  if (!auth.ok) return auth;
  const resolved = auth.data;

  const ticket = queries.getTicketByTicketId(ctx.db, input.ticketId, ctx.repoId);
  if (!ticket) return err("not_found", `Ticket not found: ${input.ticketId}`);

  if (resolved.role === "developer" && ticket.assigneeAgentId !== resolved.agentId) {
    return err("denied", "Developers can only transition tickets assigned to themselves");
  }

  const current = ticket.status as TicketStatusType;
  const validTargets = VALID_TRANSITIONS[current];
  if (!validTargets?.includes(input.status)) {
    return err("invalid_request", `Invalid transition: ${current} → ${input.status}`, {
      validTransitions: validTargets,
    });
  }

  const key = `${current}→${input.status}`;
  const allowed = TRANSITION_ROLES[key];
  if (allowed && !allowed.includes(resolved.role)) {
    ctx.insight.warn(
      `Advisory: ${resolved.role} triggering ${key} (recommended: ${allowed.join(", ")})`,
    );
  }

  if (resolved.role !== "admin") {
    const quorumRule = resolveTicketQuorumRule(current, input.status, ctx.ticketQuorum);
    const consensus = quorumRule
      ? evaluateTicketTransitionConsensus({
          ticketId: input.ticketId,
          fromStatus: current,
          toStatus: input.status,
          verdictRows: queries.getReviewVerdicts(ctx.db, ticket.id),
          config: ctx.ticketQuorum,
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
  const updates: Partial<Pick<typeof tables.tickets.$inferInsert, "status" | "resolvedByAgentId">> = {
    status: input.status,
  };
  if (input.status === "resolved") updates.resolvedByAgentId = resolved.agentId;
  if (current === "resolved" && input.status === "in_progress") updates.resolvedByAgentId = null;

  ctx.db.transaction((tx) => {
    tx.update(tables.tickets)
      .set({ ...updates, updatedAt: now })
      .where(eq(tables.tickets.id, ticket.id))
      .run();
    tx.insert(tables.ticketHistory).values({
      ticketId: ticket.id,
      fromStatus: current,
      toStatus: input.status,
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      comment: input.comment ?? null,
      timestamp: now,
    }).run();
  });
  refreshTicketSearch(ctx);

  ctx.insight.info(`Ticket ${input.ticketId}: ${current} → ${input.status} by ${resolved.agentId}`);
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

  return ok({
    ticketId: input.ticketId,
    previousStatus: current,
    status: input.status,
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
  for (const ticketId of ticketIds) {
    const update = updateTicketStatusRecord(ctx, {
      ...copyTicketActorInput(input),
      ticketId,
      status: input.toStatus,
      comment: input.comment,
    });
    if (update.ok) {
      results.push({ ticketId, ok: true });
    } else {
      results.push({ ticketId, ok: false, error: update.message });
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
  eventType: "ticket_created" | "ticket_assigned" | "ticket_status_changed" | "ticket_commented" | "ticket_linked",
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

function err(
  code: TicketServiceError["code"],
  message: string,
  data?: Record<string, unknown>,
): TicketServiceError {
  return { ok: false, code, message, data };
}

function buildConsensusBlockMessage(
  transitionKey: string,
  consensus: TransitionConsensusPayload,
): string {
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

  const passesNeeded = Math.max(0, consensus.requiredPasses - consensus.counts.pass);
  const awaiting = consensus.missingSpecializations.length > 0
    ? ` Await verdicts from: ${consensus.missingSpecializations.join(", ")}.`
    : "";
  return `Council quorum not met for ${transitionKey}: ${consensus.counts.pass}/${consensus.requiredPasses} passes (${passesNeeded} more needed).${awaiting}`;
}
