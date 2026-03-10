import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import * as queries from "../db/queries.js";
import { resolveAgent } from "./resolve-agent.js";
import { checkToolAccess } from "../trust/tiers.js";
import {
  TicketStatus, TicketSeverity,
} from "../../schemas/ticket.js";
import type { TicketStatus as TicketStatusType } from "../../schemas/ticket.js";
import {
  assignTicketRecord,
  commentTicketRecord,
  createTicketRecord,
  updateTicketStatusRecord,
} from "../tickets/service.js";

type GetContext = () => Promise<AgoraContext>;

export function registerTicketTools(server: McpServer, getContext: GetContext): void {
  // ─── create_ticket ──────────────────────────────────────────
  server.tool(
    "create_ticket",
    "Create a new ticket in the backlog",
    {
      title: z.string().min(1).max(200).describe("Ticket title"),
      description: z.string().min(1).max(5000).describe("Ticket description"),
      severity: z.enum(TicketSeverity.options).default("medium"),
      priority: z.number().int().min(0).max(10).default(5),
      tags: z.array(z.string()).default([]),
      affectedPaths: z.array(z.string()).default([]),
      acceptanceCriteria: z.string().max(2000).optional(),
      agentId: z.string().describe("Creator agent ID"),
      sessionId: z.string().describe("Active session ID"),
    },
    async ({ title, description, severity, priority, tags, affectedPaths, acceptanceCriteria, agentId, sessionId }) => {
      const c = await getContext();
      const result = await createTicketRecord({
        db: c.db,
        repoId: c.repoId,
        repoPath: c.repoPath,
        insight: c.insight,
        bus: c.bus,
        refreshTicketSearch: () => c.searchRouter?.rebuildTicketFts?.(c.repoId),
      }, {
        title,
        description,
        severity,
        priority,
        tags,
        affectedPaths,
        acceptanceCriteria,
        agentId,
        sessionId,
      });
      return result.ok ? okJson(result.data) : errService(result);
    },
  );

  // ─── assign_ticket ──────────────────────────────────────────
  server.tool(
    "assign_ticket",
    "Assign a ticket. Developers self-assign from backlog or technical_analysis; admins reassign at any status.",
    {
      ticketId: z.string().describe("Ticket ID (TKT-...)"),
      assigneeAgentId: z.string().describe("Agent to assign"),
      agentId: z.string().describe("Requesting agent ID"),
      sessionId: z.string().describe("Active session ID"),
    },
    async ({ ticketId, assigneeAgentId, agentId, sessionId }) => {
      const c = await getContext();
      const result = assignTicketRecord({
        db: c.db,
        repoId: c.repoId,
        repoPath: c.repoPath,
        insight: c.insight,
        bus: c.bus,
        refreshTicketSearch: () => c.searchRouter?.rebuildTicketFts?.(c.repoId),
      }, {
        ticketId,
        assigneeAgentId,
        agentId,
        sessionId,
      });
      return result.ok ? okJson(result.data) : errService(result);
    },
  );

  // ─── update_ticket_status ───────────────────────────────────
  server.tool(
    "update_ticket_status",
    "Transition a ticket's status. Validates against the state machine.",
    {
      ticketId: z.string().describe("Ticket ID (TKT-...)"),
      status: z.enum(TicketStatus.options).describe("Target status"),
      comment: z.string().max(500).optional(),
      agentId: z.string().describe("Requesting agent ID"),
      sessionId: z.string().describe("Active session ID"),
    },
    async ({ ticketId, status: targetStatus, comment, agentId, sessionId }) => {
      const c = await getContext();
      const result = updateTicketStatusRecord({
        db: c.db,
        repoId: c.repoId,
        repoPath: c.repoPath,
        insight: c.insight,
        bus: c.bus,
        refreshTicketSearch: () => c.searchRouter?.rebuildTicketFts?.(c.repoId),
      }, {
        ticketId,
        status: targetStatus as TicketStatusType,
        comment,
        agentId,
        sessionId,
      });
      return result.ok ? okJson(result.data) : errService(result);
    },
  );

  // ─── update_ticket ──────────────────────────────────────────
  server.tool(
    "update_ticket",
    "Update ticket metadata. Creator or admin only.",
    {
      ticketId: z.string().describe("Ticket ID (TKT-...)"),
      title: z.string().min(1).max(200).optional(),
      description: z.string().min(1).max(5000).optional(),
      severity: z.enum(TicketSeverity.options).optional(),
      priority: z.number().int().min(0).max(10).optional(),
      tags: z.array(z.string()).optional(),
      affectedPaths: z.array(z.string()).optional(),
      acceptanceCriteria: z.string().max(2000).optional(),
      agentId: z.string().describe("Requesting agent ID"),
      sessionId: z.string().describe("Active session ID"),
    },
    async (input) => {
      const c = await getContext();
      const resolved = resolveAgent(c, input.agentId, input.sessionId);
      if (!resolved) return errText("Agent or session not found / inactive");

      const access = checkToolAccess("update_ticket", resolved.role, resolved.trustTier);
      if (!access.allowed) return errJson({ denied: true, reason: access.reason });

      const ticket = queries.getTicketByTicketId(c.db, input.ticketId);
      if (!ticket) return errText(`Ticket not found: ${input.ticketId}`);

      if (ticket.creatorAgentId !== input.agentId && resolved.role !== "admin") {
        return errText("Only the ticket creator or admin can update ticket metadata");
      }

      const updates: Record<string, unknown> = {};
      if (input.title !== undefined) updates.title = input.title;
      if (input.description !== undefined) updates.description = input.description;
      if (input.severity !== undefined) updates.severity = input.severity;
      if (input.priority !== undefined) updates.priority = input.priority;
      if (input.tags !== undefined) updates.tagsJson = JSON.stringify(input.tags);
      if (input.affectedPaths !== undefined) updates.affectedPathsJson = JSON.stringify(input.affectedPaths);
      if (input.acceptanceCriteria !== undefined) updates.acceptanceCriteria = input.acceptanceCriteria;

      if (Object.keys(updates).length === 0) return errText("No updates provided");

      queries.updateTicket(c.db, ticket.id, updates as Parameters<typeof queries.updateTicket>[2]);
      try {
        c.searchRouter?.rebuildTicketFts?.(c.repoId);
      } catch (error) {
        c.insight.warn(`Ticket search refresh failed: ${error}`);
      }
      return okJson({ ticketId: input.ticketId, updated: Object.keys(updates) });
    },
  );

  // ─── list_tickets ───────────────────────────────────────────
  server.tool(
    "list_tickets",
    "List tickets with optional filters",
    {
      agentId: z.string().describe("Requesting agent ID"),
      sessionId: z.string().describe("Active session ID"),
      status: z.enum(TicketStatus.options).optional(),
      assigneeAgentId: z.string().optional(),
      severity: z.enum(TicketSeverity.options).optional(),
      creatorAgentId: z.string().optional(),
      tags: z.array(z.string()).optional().describe("Filter by tags (AND logic)"),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ agentId, sessionId, status, assigneeAgentId, severity, creatorAgentId, tags, limit }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved) return errText("Agent or session not found / inactive");

      const access = checkToolAccess("list_tickets", resolved.role, resolved.trustTier);
      if (!access.allowed) return errJson({ denied: true, reason: access.reason });

      const tickets = queries.getTicketsByRepo(c.db, c.repoId, {
        status, assigneeAgentId, severity, creatorAgentId, tags, limit,
      });
      return okJson({
        count: tickets.length,
        tickets: tickets.map((t) => ({
          ticketId: t.ticketId, title: t.title, status: t.status,
          severity: t.severity, priority: t.priority,
          assigneeAgentId: t.assigneeAgentId, creatorAgentId: t.creatorAgentId,
          updatedAt: t.updatedAt,
        })),
      });
    },
  );

  // ─── search_tickets ───────────────────────────────────────
  server.tool(
    "search_tickets",
    "Search tickets by title, description, tags, or ticket ID with optional structured filters.",
    {
      query: z.string().min(1).max(1000).describe("Search query"),
      agentId: z.string().describe("Requesting agent ID"),
      sessionId: z.string().describe("Active session ID"),
      status: z.enum(TicketStatus.options).optional(),
      severity: z.enum(TicketSeverity.options).optional(),
      assigneeAgentId: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async ({ query, agentId, sessionId, status, severity, assigneeAgentId, limit }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved) return errText("Agent or session not found / inactive");

      const access = checkToolAccess("search_tickets", resolved.role, resolved.trustTier);
      if (!access.allowed) return errJson({ denied: true, reason: access.reason });

      const results = c.searchRouter.searchTickets(query, c.repoId, limit, {
        status,
        severity,
        assigneeAgentId,
      });

      const tickets = results.flatMap((result) => {
        const ticket = queries.getTicketById(c.db, result.ticketInternalId);
        if (!ticket) return [];
        return [{
          ticketId: ticket.ticketId,
          title: ticket.title,
          status: ticket.status,
          severity: ticket.severity,
          priority: ticket.priority,
          assigneeAgentId: ticket.assigneeAgentId,
          creatorAgentId: ticket.creatorAgentId,
          tags: ticket.tagsJson ? JSON.parse(ticket.tagsJson) : [],
          updatedAt: ticket.updatedAt,
          score: Math.round(result.score * 1000) / 1000,
        }];
      });

      return okJson({
        query,
        count: tickets.length,
        tickets,
      });
    },
  );

  // ─── get_ticket ─────────────────────────────────────────────
  server.tool(
    "get_ticket",
    "Get full ticket details with history, comments, and linked patches",
    {
      ticketId: z.string().describe("Ticket ID (TKT-...)"),
      agentId: z.string().describe("Requesting agent ID"),
      sessionId: z.string().describe("Active session ID"),
    },
    async ({ ticketId, agentId, sessionId }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved) return errText("Agent or session not found / inactive");

      const access = checkToolAccess("get_ticket", resolved.role, resolved.trustTier);
      if (!access.allowed) return errJson({ denied: true, reason: access.reason });

      const ticket = queries.getTicketByTicketId(c.db, ticketId);
      if (!ticket) return errText(`Ticket not found: ${ticketId}`);

      const [history, comments, linkedPatches] = [
        queries.getTicketHistory(c.db, ticket.id),
        queries.getTicketComments(c.db, ticket.id),
        queries.getPatchesByTicketId(c.db, ticket.id),
      ];

      return okJson({
        ticketId: ticket.ticketId, title: ticket.title,
        description: ticket.description, status: ticket.status,
        severity: ticket.severity, priority: ticket.priority,
        tags: ticket.tagsJson ? JSON.parse(ticket.tagsJson) : [],
        affectedPaths: ticket.affectedPathsJson ? JSON.parse(ticket.affectedPathsJson) : [],
        acceptanceCriteria: ticket.acceptanceCriteria,
        creatorAgentId: ticket.creatorAgentId,
        assigneeAgentId: ticket.assigneeAgentId,
        resolvedByAgentId: ticket.resolvedByAgentId,
        commitSha: ticket.commitSha,
        createdAt: ticket.createdAt, updatedAt: ticket.updatedAt,
        history: history.map((h) => ({
          fromStatus: h.fromStatus, toStatus: h.toStatus,
          agentId: h.agentId, comment: h.comment, timestamp: h.timestamp,
        })),
        comments: comments.map((cm) => ({
          agentId: cm.agentId, content: cm.content, createdAt: cm.createdAt,
        })),
        linkedPatches: linkedPatches.map((p) => ({
          proposalId: p.proposalId, state: p.state, message: p.message,
          agentId: p.agentId, createdAt: p.createdAt,
        })),
      });
    },
  );

  // ─── comment_ticket ─────────────────────────────────────────
  server.tool(
    "comment_ticket",
    "Add a comment to a ticket",
    {
      ticketId: z.string().describe("Ticket ID (TKT-...)"),
      content: z.string().min(1).max(2000).describe("Comment content"),
      agentId: z.string().describe("Commenting agent ID"),
      sessionId: z.string().describe("Active session ID"),
    },
    async ({ ticketId, content, agentId, sessionId }) => {
      const c = await getContext();
      const result = commentTicketRecord({
        db: c.db,
        repoId: c.repoId,
        repoPath: c.repoPath,
        insight: c.insight,
        bus: c.bus,
        refreshTicketSearch: () => c.searchRouter?.rebuildTicketFts?.(c.repoId),
      }, {
        ticketId,
        content,
        agentId,
        sessionId,
      });
      return result.ok ? okJson(result.data) : errService(result);
    },
  );
}

// --- Helpers ---

function okJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errText(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

function errJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], isError: true };
}

function errService(result: { message: string; data?: Record<string, unknown> }) {
  if (result.data) {
    return errJson({ error: result.message, ...result.data });
  }
  return errText(result.message);
}
