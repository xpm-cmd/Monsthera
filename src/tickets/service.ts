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
import { publishDashboardEvent } from "../dashboard/events.js";

type DB = BetterSQLite3Database<typeof schema>;

export interface TicketServiceContext {
  db: DB;
  repoId: number;
  repoPath: string;
  insight: Pick<InsightStream, "info" | "warn">;
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

  ctx.insight.info(`Ticket ${ticketId} created by ${input.agentId}`);
  publishDashboardEvent({
    type: "ticket_created",
    data: { ticketId, status: "backlog", severity: input.severity, creatorAgentId: input.agentId },
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
    if (ticket.status !== "backlog") {
      return err("invalid_request", "Developers can only assign tickets in backlog status");
    }
  }

  if (!queries.getAgent(ctx.db, input.assigneeAgentId)) {
    return err("not_found", `Assignee not found: ${input.assigneeAgentId}`);
  }

  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { assigneeAgentId: input.assigneeAgentId };

  if (ticket.status === "backlog") {
    updates.status = "assigned";
    queries.insertTicketHistory(ctx.db, {
      ticketId: ticket.id,
      fromStatus: "backlog",
      toStatus: "assigned",
      agentId: input.agentId,
      sessionId: input.sessionId,
      comment: `Assigned to ${input.assigneeAgentId}`,
      timestamp: now,
    });
  }

  queries.updateTicket(
    ctx.db,
    ticket.id,
    updates as Parameters<typeof queries.updateTicket>[2],
  );

  ctx.insight.info(`Ticket ${input.ticketId} assigned to ${input.assigneeAgentId} by ${input.agentId}`);
  publishDashboardEvent({
    type: "ticket_assigned",
    data: {
      ticketId: input.ticketId,
      assigneeAgentId: input.assigneeAgentId,
      status: updates.status ?? ticket.status,
      agentId: input.agentId,
    },
  });

  return ok({
    ticketId: input.ticketId,
    assigneeAgentId: input.assigneeAgentId,
    status: updates.status ?? ticket.status,
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

  ctx.insight.info(`Ticket ${input.ticketId}: ${current} → ${input.status} by ${input.agentId}`);
  publishDashboardEvent({
    type: "ticket_status_changed",
    data: {
      ticketId: input.ticketId,
      previousStatus: current,
      status: input.status,
      agentId: input.agentId,
    },
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

  publishDashboardEvent({
    type: "ticket_commented",
    data: { ticketId: input.ticketId, commentId: comment.id, agentId: input.agentId },
  });

  return ok({
    ticketId: input.ticketId,
    commentId: comment.id,
    agentId: input.agentId,
    content: input.content,
    createdAt: now,
  });
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

function err(
  code: TicketServiceError["code"],
  message: string,
  data?: Record<string, unknown>,
): TicketServiceError {
  return { ok: false, code, message, data };
}
