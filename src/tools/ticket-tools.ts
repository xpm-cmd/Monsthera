import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { BUILT_IN_ROLES } from "../../schemas/agent.js";
import { CouncilSpecializationId, CouncilVerdict } from "../../schemas/council.js";
import type { AgoraContext } from "../core/context.js";
import {
  AgentIdSchema,
  AffectedPathsSchema,
  MAX_TICKET_LONG_TEXT_LENGTH,
  SessionIdSchema,
  TagsSchema,
  TicketIdSchema,
  parseStringArrayJson,
} from "../core/input-hardening.js";
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
  linkTicketsRecord,
  unlinkTicketsRecord,
  updateTicketStatusRecord,
} from "../tickets/service.js";
import {
  buildTicketDetailPayload,
  buildTicketListPayload,
} from "../tickets/read-model.js";
import {
  buildGovernanceOptions,
  buildTicketConsensusReport,
  getAutoAdvanceTarget,
  GATED_TICKET_TRANSITIONS,
  inferConsensusTransitionForTicketStatus,
} from "../tickets/consensus.js";

type GetContext = () => Promise<AgoraContext>;
const ConsensusTransitionSchema = z.enum(GATED_TICKET_TRANSITIONS);

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
      tags: TagsSchema.default([]),
      affectedPaths: AffectedPathsSchema.default([]),
      acceptanceCriteria: z.string().max(MAX_TICKET_LONG_TEXT_LENGTH).optional(),
      agentId: AgentIdSchema.describe("Creator agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ title, description, severity, priority, tags, affectedPaths, acceptanceCriteria, agentId, sessionId }) => {
      const c = await getContext();
      const result = await createTicketRecord({
        db: c.db,
        repoId: c.repoId,
        repoPath: c.repoPath,
        insight: c.insight,
        ticketQuorum: c.config?.ticketQuorum,
        governance: c.config?.governance,
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
    "Assign a ticket owner. Developers may self-assign unowned tickets from backlog, technical_analysis, or approved; privileged roles may reassign at any status.",
    {
      ticketId: TicketIdSchema.describe("Ticket ID (TKT-...)"),
      assigneeAgentId: AgentIdSchema.describe("Agent to assign"),
      agentId: AgentIdSchema.describe("Requesting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ ticketId, assigneeAgentId, agentId, sessionId }) => {
      const c = await getContext();
      const result = assignTicketRecord({
        db: c.db,
        repoId: c.repoId,
        repoPath: c.repoPath,
        insight: c.insight,
        ticketQuorum: c.config?.ticketQuorum,
        governance: c.config?.governance,
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
    "Transition a ticket's status. Validates against the state machine. Developers can only transition tickets assigned to themselves.",
    {
      ticketId: TicketIdSchema.describe("Ticket ID (TKT-...)"),
      status: z.enum(TicketStatus.options).describe("Target status"),
      comment: z.string().max(500).optional(),
      skipKnowledgeCapture: z.boolean().optional().describe("Skip automatic repo knowledge capture when transitioning to resolved or closed"),
      agentId: AgentIdSchema.describe("Requesting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ ticketId, status: targetStatus, comment, skipKnowledgeCapture, agentId, sessionId }) => {
      const c = await getContext();
      const result = updateTicketStatusRecord({
        db: c.db,
        repoId: c.repoId,
        repoPath: c.repoPath,
        insight: c.insight,
        ticketQuorum: c.config?.ticketQuorum,
        governance: c.config?.governance,
        bus: c.bus,
        refreshTicketSearch: () => c.searchRouter?.rebuildTicketFts?.(c.repoId),
        refreshKnowledgeSearch: (knowledgeIds?: number[]) => {
          if (knowledgeIds && knowledgeIds.length > 0) {
            for (const knowledgeId of knowledgeIds) {
              c.searchRouter?.upsertKnowledgeFts?.(c.sqlite, knowledgeId);
            }
            return;
          }
          c.searchRouter?.rebuildKnowledgeFts?.(c.sqlite);
        },
      }, {
        ticketId,
        status: targetStatus as TicketStatusType,
        comment,
        skipKnowledgeCapture,
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
      ticketId: TicketIdSchema.describe("Ticket ID (TKT-...)"),
      title: z.string().min(1).max(200).optional(),
      description: z.string().min(1).max(5000).optional(),
      severity: z.enum(TicketSeverity.options).optional(),
      priority: z.number().int().min(0).max(10).optional(),
      tags: TagsSchema.optional(),
      affectedPaths: AffectedPathsSchema.optional(),
      acceptanceCriteria: z.string().max(MAX_TICKET_LONG_TEXT_LENGTH).optional(),
      agentId: AgentIdSchema.describe("Requesting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async (input) => {
      const c = await getContext();
      const result = resolveAgent(c, input.agentId, input.sessionId);
      if (!result.ok) return errText(result.error);
      const resolved = result.agent;

      const access = checkToolAccess("update_ticket", resolved.role, resolved.trustTier);
      if (!access.allowed) return errJson({ denied: true, reason: access.reason });

      const ticket = queries.getTicketByTicketId(c.db, input.ticketId, c.repoId);
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
      agentId: AgentIdSchema.describe("Requesting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
      status: z.enum(TicketStatus.options).optional(),
      assigneeAgentId: AgentIdSchema.optional(),
      severity: z.enum(TicketSeverity.options).optional(),
      creatorAgentId: AgentIdSchema.optional(),
      tags: TagsSchema.optional().describe("Filter by tags (AND logic)"),
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ agentId, sessionId, status, assigneeAgentId, severity, creatorAgentId, tags, limit }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return errText(result.error);
      const resolved = result.agent;

      const access = checkToolAccess("list_tickets", resolved.role, resolved.trustTier);
      if (!access.allowed) return errJson({ denied: true, reason: access.reason });

      return okJson(buildTicketListPayload(c.db, c.repoId, {
        status,
        assigneeAgentId,
        severity,
        creatorAgentId,
        tags,
        limit,
      }));
    },
  );

  // ─── search_tickets ───────────────────────────────────────
  server.tool(
    "search_tickets",
    "Search tickets by title, description, tags, or ticket ID with optional structured filters.",
    {
      query: z.string().trim().min(1).max(1000).describe("Search query"),
      agentId: AgentIdSchema.describe("Requesting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
      status: z.enum(TicketStatus.options).optional(),
      severity: z.enum(TicketSeverity.options).optional(),
      assigneeAgentId: AgentIdSchema.optional(),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async ({ query, agentId, sessionId, status, severity, assigneeAgentId, limit }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return errText(result.error);
      const resolved = result.agent;

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
          tags: parseStringArrayJson(ticket.tagsJson, {
            maxItems: 25,
            maxItemLength: 64,
          }),
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
      ticketId: TicketIdSchema.describe("Ticket ID (TKT-...)"),
      agentId: AgentIdSchema.describe("Requesting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ ticketId, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return errText(result.error);
      const resolved = result.agent;

      const access = checkToolAccess("get_ticket", resolved.role, resolved.trustTier);
      if (!access.allowed) return errJson({ denied: true, reason: access.reason });

      const payload = buildTicketDetailPayload(c.db, c.repoId, ticketId);
      if (!payload) return errText(`Ticket not found: ${ticketId}`);
      return okJson(payload);
    },
  );

  // ─── comment_ticket ─────────────────────────────────────────
  server.tool(
    "comment_ticket",
    "Add a comment to a ticket",
    {
      ticketId: TicketIdSchema.describe("Ticket ID (TKT-...)"),
      content: z.string().min(1).max(MAX_TICKET_LONG_TEXT_LENGTH).describe("Comment content"),
      agentId: AgentIdSchema.describe("Commenting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ ticketId, content, agentId, sessionId }) => {
      const c = await getContext();
      const result = commentTicketRecord({
        db: c.db,
        repoId: c.repoId,
        repoPath: c.repoPath,
        insight: c.insight,
        ticketQuorum: c.config?.ticketQuorum,
        governance: c.config?.governance,
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

  // ─── assign_council ────────────────────────────────────────
  server.tool(
    "assign_council",
    "Assign a council specialization to an agent for a specific ticket",
    {
      ticketId: TicketIdSchema.describe("Ticket ID (TKT-...)"),
      councilAgentId: AgentIdSchema.describe("Agent assigned to represent the specialization"),
      specialization: CouncilSpecializationId.describe("Council specialization being assigned"),
      agentId: AgentIdSchema.describe("Requesting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ ticketId, councilAgentId, specialization, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return errText(result.error);
      const resolved = result.agent;

      const access = checkToolAccess("assign_council", resolved.role, resolved.trustTier);
      if (!access.allowed || !BUILT_IN_ROLES[resolved.role].permissions.canTransitionTicket) {
        return errJson({ denied: true, reason: access.reason ?? "Role cannot assign council members" });
      }

      const ticket = queries.getTicketByTicketId(c.db, ticketId, c.repoId);
      if (!ticket) return errText(`Ticket not found: ${ticketId}`);

      const councilAgent = queries.getAgent(c.db, councilAgentId);
      if (!councilAgent) return errText(`Agent not found: ${councilAgentId}`);
      if (!(councilAgent.roleId in BUILT_IN_ROLES)) {
        return errJson({
          denied: true,
          reason: `Agent ${councilAgentId} has unsupported role ${councilAgent.roleId}`,
        });
      }
      if (councilAgent.trustTier !== "A" && councilAgent.trustTier !== "B") {
        return errJson({
          denied: true,
          reason: `Agent ${councilAgentId} has unsupported trust tier ${councilAgent.trustTier}`,
        });
      }
      const councilRole = councilAgent.roleId as keyof typeof BUILT_IN_ROLES;

      const councilAccess = checkToolAccess("submit_verdict", councilRole, councilAgent.trustTier);
      if (!councilAccess.allowed || !BUILT_IN_ROLES[councilRole].permissions.canTransitionTicket) {
        return errJson({
          denied: true,
          reason: `Agent ${councilAgentId} cannot serve as a council reviewer`,
        });
      }

      const now = new Date().toISOString();
      const assignment = queries.upsertCouncilAssignment(c.db, {
        ticketId: ticket.id,
        agentId: councilAgentId,
        specialization,
        assignedByAgentId: resolved.agentId,
        assignedAt: now,
      });
      queries.updateTicket(c.db, ticket.id, {});

      return okJson({
        ticketId,
        assignment: {
          agentId: assignment.agentId,
          specialization: assignment.specialization,
          assignedByAgentId: assignment.assignedByAgentId,
          assignedAt: assignment.assignedAt,
        },
      });
    },
  );

  // ─── submit_verdict ────────────────────────────────────────
  server.tool(
    "submit_verdict",
    "Record or replace the latest advisory council verdict for a ticket specialization, optionally evaluating a specific gated transition",
    {
      ticketId: TicketIdSchema.describe("Ticket ID (TKT-...)"),
      specialization: CouncilSpecializationId.describe("Council specialization submitting the verdict"),
      verdict: CouncilVerdict.describe("Verdict: pass, fail, or abstain"),
      reasoning: z.string().min(1).max(MAX_TICKET_LONG_TEXT_LENGTH).optional().describe("Optional reasoning for the verdict"),
      transition: ConsensusTransitionSchema.optional().describe("Optional gated transition to evaluate against repo quorum config"),
      agentId: AgentIdSchema.describe("Submitting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ ticketId, specialization, verdict, reasoning, transition, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return errText(result.error);
      const resolved = result.agent;

      const access = checkToolAccess("submit_verdict", resolved.role, resolved.trustTier);
      if (!access.allowed || !BUILT_IN_ROLES[resolved.role].permissions.canTransitionTicket) {
        return errJson({ denied: true, reason: access.reason ?? "Role cannot submit council verdicts" });
      }

      const ticket = queries.getTicketByTicketId(c.db, ticketId, c.repoId);
      if (!ticket) return errText(`Ticket not found: ${ticketId}`);

      if (c.config?.governance?.requireBinding && resolved.role !== "admin") {
        const assignment = queries.getCouncilAssignment(c.db, ticket.id, resolved.agentId, specialization);
        if (!assignment) {
          return errJson({
            denied: true,
            reason: `Agent ${resolved.agentId} is not assigned as ${specialization} for ${ticketId}`,
          });
        }
      }

      const now = new Date().toISOString();
      const stored = queries.upsertReviewVerdict(c.db, {
        ticketId: ticket.id,
        agentId: resolved.agentId,
        sessionId: resolved.sessionId,
        specialization,
        verdict,
        reasoning: reasoning ?? null,
        createdAt: now,
      });
      queries.updateTicket(c.db, ticket.id, {});
      const verdictRows = queries.getReviewVerdicts(c.db, ticket.id);
      const govOpts = buildGovernanceOptions(c.config?.governance, verdictRows, (aid) => {
        const a = queries.getAgent(c.db, aid);
        return a ? { roleId: a.roleId, provider: a.provider, model: a.model } : undefined;
      });

      const consensus = buildTicketConsensusReport({
        ticketId,
        verdictRows,
        config: c.config?.ticketQuorum,
        transition: transition ?? inferConsensusTransitionForTicketStatus(ticket.status as TicketStatusType),
        governance: govOpts,
      });

      let autoAdvanced: { previousStatus: string; status: string } | null = null;
      if (consensus.advisoryReady && c.config?.governance?.autoAdvance !== false) {
        const target = getAutoAdvanceTarget(ticket.status as TicketStatusType);
        if (target) {
          const advanceResult = updateTicketStatusRecord({
            db: c.db,
            repoId: c.repoId,
            repoPath: c.repoPath,
            insight: c.insight,
            ticketQuorum: c.config?.ticketQuorum,
            governance: c.config?.governance,
            bus: c.bus,
            refreshTicketSearch: () => c.searchRouter?.rebuildTicketFts?.(c.repoId),
            refreshKnowledgeSearch: (knowledgeIds?: number[]) => {
              if (knowledgeIds && knowledgeIds.length > 0) {
                for (const knowledgeId of knowledgeIds) {
                  c.searchRouter?.upsertKnowledgeFts?.(c.sqlite, knowledgeId);
                }
                return;
              }
              c.searchRouter?.rebuildKnowledgeFts?.(c.sqlite);
            },
            system: true,
            actorLabel: "council-auto-advance",
          }, {
            ticketId,
            status: target,
            actorLabel: "council-auto-advance",
            comment: `Auto-advanced: council quorum met (${consensus.counts.pass}/${consensus.requiredPasses} passes)`,
          });
          if (advanceResult.ok) {
            autoAdvanced = { previousStatus: ticket.status, status: target };
          }
        }
      }

      return okJson({
        ticketId,
        verdict: {
          specialization: stored.specialization,
          verdict: stored.verdict,
          agentId: stored.agentId,
          sessionId: stored.sessionId,
          reasoning: stored.reasoning,
          createdAt: stored.createdAt,
        },
        consensus,
        autoAdvanced,
      });
    },
  );

  // ─── check_consensus ──────────────────────────────────────
  server.tool(
    "check_consensus",
    "Report advisory council quorum, latest verdicts, missing roles, and architect/security vetoes, optionally for a specific gated transition",
    {
      ticketId: TicketIdSchema.describe("Ticket ID (TKT-...)"),
      transition: ConsensusTransitionSchema.optional().describe("Optional gated transition to evaluate against repo quorum config"),
      agentId: AgentIdSchema.describe("Requesting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ ticketId, transition, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return errText(result.error);
      const resolved = result.agent;

      const access = checkToolAccess("check_consensus", resolved.role, resolved.trustTier);
      if (!access.allowed) return errJson({ denied: true, reason: access.reason });

      const ticket = queries.getTicketByTicketId(c.db, ticketId, c.repoId);
      if (!ticket) return errText(`Ticket not found: ${ticketId}`);

      const verdictRows = queries.getReviewVerdicts(c.db, ticket.id);
      const govOpts = buildGovernanceOptions(c.config?.governance, verdictRows, (aid) => {
        const a = queries.getAgent(c.db, aid);
        return a ? { roleId: a.roleId, provider: a.provider, model: a.model } : undefined;
      });

      return okJson(buildTicketConsensusReport({
        ticketId,
        verdictRows,
        config: c.config?.ticketQuorum,
        transition: transition ?? inferConsensusTransitionForTicketStatus(ticket.status as TicketStatusType),
        governance: govOpts,
      }));
    },
  );

  // ─── link_tickets ──────────────────────────────────────────
  server.tool(
    "link_tickets",
    "Create a dependency between two tickets. Types: 'blocks' (A blocks B) or 'relates_to' (symmetric).",
    {
      fromTicketId: TicketIdSchema.describe("Source ticket ID (TKT-...)"),
      toTicketId: TicketIdSchema.describe("Target ticket ID (TKT-...)"),
      relationType: z.enum(["blocks", "relates_to"]).describe("Relationship type"),
      agentId: AgentIdSchema.describe("Requesting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ fromTicketId, toTicketId, relationType, agentId, sessionId }) => {
      const c = await getContext();
      const result = linkTicketsRecord({
        db: c.db,
        repoId: c.repoId,
        repoPath: c.repoPath,
        insight: c.insight,
        ticketQuorum: c.config?.ticketQuorum,
        governance: c.config?.governance,
        bus: c.bus,
        refreshTicketSearch: () => c.searchRouter?.rebuildTicketFts?.(c.repoId),
      }, {
        fromTicketId,
        toTicketId,
        relationType,
        agentId,
        sessionId,
      });
      return result.ok ? okJson(result.data) : errService(result);
    },
  );

  // ─── unlink_tickets ────────────────────────────────────────
  server.tool(
    "unlink_tickets",
    "Remove a dependency between two tickets",
    {
      fromTicketId: TicketIdSchema.describe("Source ticket ID (TKT-...)"),
      toTicketId: TicketIdSchema.describe("Target ticket ID (TKT-...)"),
      agentId: AgentIdSchema.describe("Requesting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ fromTicketId, toTicketId, agentId, sessionId }) => {
      const c = await getContext();
      const result = unlinkTicketsRecord({
        db: c.db,
        repoId: c.repoId,
        repoPath: c.repoPath,
        insight: c.insight,
        ticketQuorum: c.config?.ticketQuorum,
        governance: c.config?.governance,
        bus: c.bus,
        refreshTicketSearch: () => c.searchRouter?.rebuildTicketFts?.(c.repoId),
      }, {
        fromTicketId,
        toTicketId,
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
