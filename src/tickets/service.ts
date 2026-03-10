import { randomUUID } from "node:crypto";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as queries from "../db/queries.js";
import type { InsightStream } from "../core/insight-stream.js";
import { checkToolAccess } from "../trust/tiers.js";
import { getHead } from "../git/operations.js";
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

export interface TicketServiceContext {
  db: DB;
  repoId: number;
  repoPath: string;
  insight: Pick<InsightStream, "info" | "warn">;
  bus?: CoordinationBus;
  refreshTicketSearch?: () => void;
}

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

interface TicketActorInput {
  agentId: string;
  sessionId: string;
}

export interface CreateTicketInput extends TicketActorInput {
  title: string;
  description: string;
  severity: string;
  priority: number;
  tags: string[];
  affectedPaths: string[];
  acceptanceCriteria?: string | null;
}

export interface AssignTicketInput extends TicketActorInput {
  ticketId: string;
  assigneeAgentId: string;
}

export interface UpdateTicketStatusInput extends TicketActorInput {
  ticketId: string;
  status: TicketStatusType;
  comment?: string | null;
}

export interface CommentTicketInput extends TicketActorInput {
  ticketId: string;
  content: string;
}

export async function createTicketRecord(
  ctx: TicketServiceContext,
  input: CreateTicketInput,
): Promise<TicketServiceResult<Record<string, unknown>>> {
  const resolved = resolveTicketActor(ctx.db, input.agentId, input.sessionId);
  if (!resolved) return err("invalid_actor", "Agent or session not found / inactive");

  const access = checkToolAccess("create_ticket", resolved.role, resolved.trustTier);
  if (!access.allowed) return err("denied", access.reason, { denied: true });

  const now = new Date().toISOString();
  const ticketId = `TKT-${randomUUID().slice(0, 8)}`;
  const commitSha = await getHead({ cwd: ctx.repoPath });

  const ticket = queries.insertTicket(ctx.db, {
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
    creatorAgentId: input.agentId,
    creatorSessionId: input.sessionId,
    commitSha,
    createdAt: now,
    updatedAt: now,
  });

  queries.insertTicketHistory(ctx.db, {
    ticketId: ticket.id,
    fromStatus: null,
    toStatus: "backlog",
    agentId: input.agentId,
    sessionId: input.sessionId,
    comment: "Ticket created",
    timestamp: now,
  });
  refreshTicketSearch(ctx);

  ctx.insight.info(`Ticket ${ticketId} created by ${input.agentId}`);
  recordDashboardEvent(ctx.db, ctx.repoId, {
    type: "ticket_created",
    data: { ticketId, status: "backlog", severity: input.severity, creatorAgentId: input.agentId },
  });
  broadcastTicketRealtime(ctx, input.agentId, "ticket_created", {
    ticketId,
    status: "backlog",
    severity: input.severity,
    creatorAgentId: input.agentId,
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
  ctx: TicketServiceContext,
  input: AssignTicketInput,
): TicketServiceResult<Record<string, unknown>> {
  const resolved = resolveTicketActor(ctx.db, input.agentId, input.sessionId);
  if (!resolved) return err("invalid_actor", "Agent or session not found / inactive");

  const access = checkToolAccess("assign_ticket", resolved.role, resolved.trustTier);
  if (!access.allowed) return err("denied", access.reason, { denied: true });

  const ticket = queries.getTicketByTicketId(ctx.db, input.ticketId);
  if (!ticket) return err("not_found", `Ticket not found: ${input.ticketId}`);

  if (resolved.role === "developer") {
    if (input.assigneeAgentId !== input.agentId) {
      return err("denied", "Developers can only self-assign tickets");
    }
    if (!["backlog", "technical_analysis", "approved"].includes(ticket.status)) {
      return err("invalid_request", "Developers can only assign tickets in backlog, technical_analysis, or approved status");
    }
  }

  if (!queries.getAgent(ctx.db, input.assigneeAgentId)) {
    return err("not_found", `Assignee not found: ${input.assigneeAgentId}`);
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { assigneeAgentId: input.assigneeAgentId };

  queries.updateTicket(
    ctx.db,
    ticket.id,
    updates as Parameters<typeof queries.updateTicket>[2],
  );
  refreshTicketSearch(ctx);

  ctx.insight.info(`Ticket ${input.ticketId} assigned to ${input.assigneeAgentId} by ${input.agentId}`);
  recordDashboardEvent(ctx.db, ctx.repoId, {
    type: "ticket_assigned",
    data: {
      ticketId: input.ticketId,
      assigneeAgentId: input.assigneeAgentId,
      status: ticket.status,
      agentId: input.agentId,
    },
  });
  broadcastTicketRealtime(ctx, input.agentId, "ticket_assigned", {
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
  ctx: TicketServiceContext,
  input: UpdateTicketStatusInput,
): TicketServiceResult<Record<string, unknown>> {
  const resolved = resolveTicketActor(ctx.db, input.agentId, input.sessionId);
  if (!resolved) return err("invalid_actor", "Agent or session not found / inactive");

  const access = checkToolAccess("update_ticket_status", resolved.role, resolved.trustTier);
  if (!access.allowed) return err("denied", access.reason, { denied: true });

  const ticket = queries.getTicketByTicketId(ctx.db, input.ticketId);
  if (!ticket) return err("not_found", `Ticket not found: ${input.ticketId}`);

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

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { status: input.status };
  if (input.status === "resolved") updates.resolvedByAgentId = input.agentId;
  if (current === "resolved" && input.status === "in_progress") updates.resolvedByAgentId = null;

  queries.updateTicket(
    ctx.db,
    ticket.id,
    updates as Parameters<typeof queries.updateTicket>[2],
  );
  queries.insertTicketHistory(ctx.db, {
    ticketId: ticket.id,
    fromStatus: current,
    toStatus: input.status,
    agentId: input.agentId,
    sessionId: input.sessionId,
    comment: input.comment ?? null,
    timestamp: now,
  });
  refreshTicketSearch(ctx);

  ctx.insight.info(`Ticket ${input.ticketId}: ${current} → ${input.status} by ${input.agentId}`);
  recordDashboardEvent(ctx.db, ctx.repoId, {
    type: "ticket_status_changed",
    data: {
      ticketId: input.ticketId,
      previousStatus: current,
      status: input.status,
      agentId: input.agentId,
    },
  });
  broadcastTicketRealtime(ctx, input.agentId, "ticket_status_changed", {
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
  ctx: TicketServiceContext,
  input: CommentTicketInput,
): TicketServiceResult<Record<string, unknown>> {
  const resolved = resolveTicketActor(ctx.db, input.agentId, input.sessionId);
  if (!resolved) return err("invalid_actor", "Agent or session not found / inactive");

  const access = checkToolAccess("comment_ticket", resolved.role, resolved.trustTier);
  if (!access.allowed) return err("denied", access.reason, { denied: true });

  const ticket = queries.getTicketByTicketId(ctx.db, input.ticketId);
  if (!ticket) return err("not_found", `Ticket not found: ${input.ticketId}`);

  const now = new Date().toISOString();
  const comment = queries.insertTicketComment(ctx.db, {
    ticketId: ticket.id,
    agentId: input.agentId,
    sessionId: input.sessionId,
    content: input.content,
    createdAt: now,
  });

  recordDashboardEvent(ctx.db, ctx.repoId, {
    type: "ticket_commented",
    data: { ticketId: input.ticketId, commentId: comment.id, agentId: input.agentId },
  });
  broadcastTicketRealtime(ctx, input.agentId, "ticket_commented", {
    ticketId: input.ticketId,
    commentId: comment.id,
    agentId: input.agentId,
  });

  return ok({
    ticketId: input.ticketId,
    commentId: comment.id,
    agentId: input.agentId,
    content: input.content,
    createdAt: now,
  });
}

// --- Ticket Dependencies ---

interface LinkTicketsInput {
  fromTicketId: string; // TKT-... (the blocker)
  toTicketId: string;   // TKT-... (the blocked)
  relationType: "blocks" | "relates_to";
  agentId: string;
  sessionId: string;
}

export function linkTicketsRecord(
  ctx: TicketServiceContext,
  input: LinkTicketsInput,
): TicketServiceResult<Record<string, unknown>> {
  const resolved = resolveTicketActor(ctx.db, input.agentId, input.sessionId);
  if (!resolved) return err("invalid_actor", "Agent or session not found / inactive");

  const access = checkToolAccess("link_tickets", resolved.role, resolved.trustTier);
  if (!access.allowed) return err("denied", access.reason, { denied: true });

  const fromTicket = queries.getTicketByTicketId(ctx.db, input.fromTicketId);
  if (!fromTicket) return err("not_found", `Ticket not found: ${input.fromTicketId}`);

  const toTicket = queries.getTicketByTicketId(ctx.db, input.toTicketId);
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
    createdByAgentId: input.agentId,
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

interface UnlinkTicketsInput {
  fromTicketId: string;
  toTicketId: string;
  agentId: string;
  sessionId: string;
}

export function unlinkTicketsRecord(
  ctx: TicketServiceContext,
  input: UnlinkTicketsInput,
): TicketServiceResult<Record<string, unknown>> {
  const resolved = resolveTicketActor(ctx.db, input.agentId, input.sessionId);
  if (!resolved) return err("invalid_actor", "Agent or session not found / inactive");

  const access = checkToolAccess("unlink_tickets", resolved.role, resolved.trustTier);
  if (!access.allowed) return err("denied", access.reason, { denied: true });

  const fromTicket = queries.getTicketByTicketId(ctx.db, input.fromTicketId);
  if (!fromTicket) return err("not_found", `Ticket not found: ${input.fromTicketId}`);

  const toTicket = queries.getTicketByTicketId(ctx.db, input.toTicketId);
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

function resolveTicketActor(db: DB, agentId: string, sessionId: string): ResolvedTicketActor | null {
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

function ok<T>(data: T): TicketServiceSuccess<T> {
  return { ok: true, data };
}

function broadcastTicketRealtime(
  ctx: TicketServiceContext,
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

function refreshTicketSearch(ctx: TicketServiceContext): void {
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
