import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { parseStringArrayJson } from "../core/input-hardening.js";
import * as queries from "../db/queries.js";
import type * as schema from "../db/schema.js";

type DB = BetterSQLite3Database<typeof schema>;

export interface TicketListFilters {
  status?: string;
  assigneeAgentId?: string;
  severity?: string;
  creatorAgentId?: string;
  tags?: string[];
  limit?: number;
}

export interface TicketListItem {
  ticketId: string;
  title: string;
  status: string;
  severity: string;
  priority: number;
  assigneeAgentId: string | null;
  creatorAgentId: string;
  updatedAt: string;
}

export interface TicketListPayload {
  count: number;
  tickets: TicketListItem[];
}

export interface TicketDetailPayload {
  ticketId: string;
  title: string;
  description: string;
  status: string;
  severity: string;
  priority: number;
  tags: string[];
  affectedPaths: string[];
  acceptanceCriteria: string | null;
  creatorAgentId: string;
  assigneeAgentId: string | null;
  resolvedByAgentId: string | null;
  commitSha: string;
  resolutionCommitShas: string[];
  createdAt: string;
  updatedAt: string;
  dependencies: {
    blocking: string[];
    blockedBy: string[];
    relatedTo: string[];
  };
  history: Array<{
    fromStatus: string | null;
    toStatus: string;
    agentId: string;
    comment: string | null;
    timestamp: string;
  }>;
  comments: Array<{
    agentId: string;
    content: string;
    createdAt: string;
  }>;
  linkedPatches: Array<{
    proposalId: string;
    state: string;
    message: string;
    agentId: string;
    createdAt: string;
  }>;
  workGroups: Array<{
    groupId: string;
    title: string;
    status: string;
  }>;
}

export interface TicketSummaryPayload {
  totalCount: number;
  openCount: number;
  statusCounts: Record<string, number>;
  severityCounts: Record<string, number>;
  inProgress: TicketListItem[];
  inReview: TicketListItem[];
  blocked: TicketListItem[];
}

export function buildTicketListPayload(
  db: DB,
  repoId: number,
  filters?: TicketListFilters,
): TicketListPayload {
  const tickets = queries.getTicketsByRepo(db, repoId, filters);
  return {
    count: tickets.length,
    tickets: tickets.map((ticket) => ({
      ticketId: ticket.ticketId,
      title: ticket.title,
      status: ticket.status,
      severity: ticket.severity,
      priority: ticket.priority,
      assigneeAgentId: ticket.assigneeAgentId,
      creatorAgentId: ticket.creatorAgentId,
      updatedAt: ticket.updatedAt,
    })),
  };
}

export function buildTicketDetailPayload(
  db: DB,
  repoId: number,
  ticketId: string,
): TicketDetailPayload | null {
  const ticket = queries.getTicketByTicketId(db, ticketId, repoId);
  if (!ticket) return null;

  const history = queries.getTicketHistory(db, ticket.id);
  const comments = queries.getTicketComments(db, ticket.id);
  const linkedPatches = queries.getPatchesByTicketId(db, ticket.id);
  const dependencies = resolveTicketDependencies(db, ticket.id);
  const resolutionCommitShas = queries.getTicketResolutionCommitShas(db, ticket.id);

  return {
    ticketId: ticket.ticketId,
    title: ticket.title,
    description: ticket.description,
    status: ticket.status,
    severity: ticket.severity,
    priority: ticket.priority,
    tags: parseStringArrayJson(ticket.tagsJson, {
      maxItems: 25,
      maxItemLength: 64,
    }),
    affectedPaths: parseStringArrayJson(ticket.affectedPathsJson, {
      maxItems: 100,
      maxItemLength: 500,
    }),
    acceptanceCriteria: ticket.acceptanceCriteria,
    creatorAgentId: ticket.creatorAgentId,
    assigneeAgentId: ticket.assigneeAgentId,
    resolvedByAgentId: ticket.resolvedByAgentId,
    commitSha: ticket.commitSha,
    resolutionCommitShas,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    dependencies,
    history: history.map((entry) => ({
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      agentId: entry.agentId,
      comment: entry.comment,
      timestamp: entry.timestamp,
    })),
    comments: comments.map((entry) => ({
      agentId: entry.agentId,
      content: entry.content,
      createdAt: entry.createdAt,
    })),
    linkedPatches: linkedPatches.map((entry) => ({
      proposalId: entry.proposalId,
      state: entry.state,
      message: entry.message,
      agentId: entry.agentId,
      createdAt: entry.createdAt,
    })),
    workGroups: queries.getWorkGroupsForTicket(db, ticket.id),
  };
}

export function buildTicketSummaryPayload(db: DB, repoId: number): TicketSummaryPayload {
  return {
    totalCount: queries.getTotalTicketCount(db, repoId),
    openCount: queries.getOpenTicketCount(db, repoId),
    statusCounts: queries.getTicketCountsByStatus(db, repoId),
    severityCounts: queries.getTicketCountsBySeverity(db, repoId),
    inProgress: buildTicketListPayload(db, repoId, { status: "in_progress", limit: 10 }).tickets,
    inReview: buildTicketListPayload(db, repoId, { status: "in_review", limit: 10 }).tickets,
    blocked: buildTicketListPayload(db, repoId, { status: "blocked", limit: 10 }).tickets,
  };
}

function resolveTicketDependencies(
  db: DB,
  ticketInternalId: number,
): TicketDetailPayload["dependencies"] {
  const deps = queries.getTicketDependencies(db, ticketInternalId);
  const ticketIdCache = new Map<number, string>();
  const resolvePublicId = (internalId: number) => {
    if (ticketIdCache.has(internalId)) return ticketIdCache.get(internalId)!;
    const ticket = queries.getTicketById(db, internalId);
    const publicId = ticket?.ticketId ?? `#${internalId}`;
    ticketIdCache.set(internalId, publicId);
    return publicId;
  };

  const blocking = deps.outgoing
    .filter((entry) => entry.relationType === "blocks")
    .map((entry) => resolvePublicId(entry.toTicketId));
  const blockedBy = deps.incoming
    .filter((entry) => entry.relationType === "blocks")
    .map((entry) => resolvePublicId(entry.fromTicketId));
  const relatedTo = [
    ...deps.outgoing
      .filter((entry) => entry.relationType === "relates_to")
      .map((entry) => resolvePublicId(entry.toTicketId)),
    ...deps.incoming
      .filter((entry) => entry.relationType === "relates_to")
      .map((entry) => resolvePublicId(entry.fromTicketId)),
  ];

  return { blocking, blockedBy, relatedTo };
}
