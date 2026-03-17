import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { and, eq, or, sql } from "drizzle-orm";
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
import * as tables from "../db/schema.js";
import { recordDashboardEvent } from "../dashboard/events.js";
import { resolveAgent } from "./resolve-agent.js";
import { checkToolAccess } from "../trust/tiers.js";
import { okJson, errText, errJson, errService } from "./response-helpers.js";
import { getHead } from "../git/operations.js";
import {
  TicketStatus, TicketSeverity,
} from "../../schemas/ticket.js";
import { DEFAULT_AUTO_ADVANCE_EXCLUDED_TAGS } from "../../schemas/governance.js";
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
  GATED_ADVANCE_TARGET,
  GATED_TICKET_TRANSITIONS,
  inferConsensusTransitionForTicketStatus,
} from "../tickets/consensus.js";
import { spawnRepairTicket } from "../tickets/repair-spawner.js";

type GetContext = () => Promise<AgoraContext>;
const ConsensusTransitionSchema = z.enum(GATED_TICKET_TRANSITIONS);
const MIN_VERDICT_REASONING_LENGTH = 50;
const GENERIC_VERDICT_PATTERNS = [
  /^autonomous council review for\b/i,
  /^(?:pass|approved|lgtm|looks good)\.?$/i,
];
const CONCRETE_EVIDENCE_PATTERNS = [
  /\b(?:src|tests|docs|schemas|\.agora)\/[\w./-]+/,
  /`[^`]+`/,
  /\b[A-Za-z_][A-Za-z0-9_]*\(\)/,
  /\b[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*\b/,
] as const;

interface VerdictReasoningValidationResult {
  ok: true;
  normalizedReasoning: string | null;
}

interface VerdictReasoningValidationError {
  ok: false;
  message: string;
  data?: Record<string, unknown>;
}

function normalizeVerdictReasoning(reasoning: string | null | undefined): string | null {
  if (typeof reasoning !== "string") return null;
  const normalized = reasoning.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function buildSpecializationGuidance(specialization: string): string {
  switch (specialization) {
    case "architect":
      return "reference boundaries, contracts, or data flow";
    case "security":
      return "reference trust boundaries, validation, or exposure risk";
    case "performance":
      return "reference hot paths, queries, or runtime cost";
    case "patterns":
      return "reference naming, duplication, or consistency";
    case "simplifier":
      return "reference avoidable complexity or a simpler alternative";
    case "design":
      return "reference UX structure or interaction details";
    default:
      return "reference concrete code or design evidence";
  }
}

function resolveVerdictAuthorization(
  agentId: string,
  specialization: string,
  ticketInternalId: number,
  context: { db: AgoraContext["db"]; config: any; role: string },
): { authorized: boolean; authorizedBy: string | null; reason?: string } {
  // 1. Admin always authorized
  if (context.role === "admin") return { authorized: true, authorizedBy: "admin_override" };

  // 2. Check explicit council assignment
  const assignment = queries.getCouncilAssignment(context.db, ticketInternalId, agentId, specialization);
  if (assignment) return { authorized: true, authorizedBy: "council_assignment" };

  // 3. If requireBinding is false, allow with "binding_disabled" audit trail
  if (!context.config?.governance?.requireBinding) return { authorized: true, authorizedBy: "binding_disabled" };

  // 4. Not authorized
  return { authorized: false, authorizedBy: null, reason: `Agent ${agentId} is not assigned as ${specialization}` };
}

function validateReviewerModelVoterCap(input: {
  ticketInternalId: number;
  agentId: string;
  db: AgoraContext["db"];
  maxVotersPerModel?: number;
}): VerdictReasoningValidationResult | VerdictReasoningValidationError {
  if (!Number.isFinite(input.maxVotersPerModel) || (input.maxVotersPerModel ?? 0) < 1) {
    return { ok: true, normalizedReasoning: null };
  }

  const currentAgent = queries.getAgent(input.db, input.agentId);
  if (!currentAgent?.provider || !currentAgent.model) {
    return { ok: true, normalizedReasoning: null };
  }

  const activeVerdicts = queries.getActiveReviewVerdicts(input.db, input.ticketInternalId);
  const sameModelAgentIds = new Set<string>();

  for (const verdictRow of activeVerdicts) {
    if (verdictRow.agentId === input.agentId) continue;
    const agent = queries.getAgent(input.db, verdictRow.agentId);
    if (!agent?.provider || !agent.model) continue;
    if (agent.provider === currentAgent.provider && agent.model === currentAgent.model) {
      sameModelAgentIds.add(agent.id);
    }
  }

  if (sameModelAgentIds.size >= input.maxVotersPerModel!) {
    return {
      ok: false,
      message: `Model voter cap exceeded for ${currentAgent.provider}/${currentAgent.model}. This council gate allows at most ${input.maxVotersPerModel} distinct reviewers on the same model.`,
      data: {
        validation: "model_voter_cap",
        provider: currentAgent.provider,
        model: currentAgent.model,
        maxVotersPerModel: input.maxVotersPerModel,
        activeSameModelVoters: [...sameModelAgentIds],
      },
    };
  }

  return { ok: true, normalizedReasoning: null };
}

function validateVerdictReasoning(input: {
  reasoning: string | null | undefined;
  verdict: string;
  specialization: string;
  ticketInternalId: number;
  agentId: string;
  db: AgoraContext["db"];
}): VerdictReasoningValidationResult | VerdictReasoningValidationError {
  const normalizedReasoning = normalizeVerdictReasoning(input.reasoning);
  if (input.verdict === "abstain") {
    return { ok: true, normalizedReasoning };
  }

  if (!normalizedReasoning || normalizedReasoning.length < MIN_VERDICT_REASONING_LENGTH) {
    return {
      ok: false,
      message: `Pass/fail verdicts require at least ${MIN_VERDICT_REASONING_LENGTH} characters of concrete reasoning.`,
      data: {
        validation: "reasoning_length",
        specialization: input.specialization,
        verdict: input.verdict,
        reasoningLength: normalizedReasoning?.length ?? 0,
      },
    };
  }

  if (GENERIC_VERDICT_PATTERNS.some((pattern) => pattern.test(normalizedReasoning))) {
    return {
      ok: false,
      message: "Verdict reasoning is too generic. Reference concrete code or architecture evidence instead of a template approval.",
      data: {
        validation: "reasoning_template",
        specialization: input.specialization,
        verdict: input.verdict,
      },
    };
  }

  if (!CONCRETE_EVIDENCE_PATTERNS.some((pattern) => pattern.test(normalizedReasoning))) {
    return {
      ok: false,
      message: `Verdict reasoning must reference concrete code or design evidence; ${buildSpecializationGuidance(input.specialization)}.`,
      data: {
        validation: "reasoning_specificity",
        specialization: input.specialization,
        verdict: input.verdict,
      },
    };
  }

  const priorVerdicts = queries.getActiveVerdictsByAgentForTicket(input.db, input.ticketInternalId, input.agentId);
  const duplicate = priorVerdicts.find((verdictRow) => {
    if (verdictRow.specialization === input.specialization) return false;
    return normalizeVerdictReasoning(verdictRow.reasoning)?.toLowerCase() === normalizedReasoning.toLowerCase();
  });
  if (duplicate) {
    return {
      ok: false,
      message: `Verdict reasoning duplicates your active ${duplicate.specialization} review. Each specialization needs distinct analysis.`,
      data: {
        validation: "reasoning_duplicate",
        specialization: input.specialization,
        duplicateSpecialization: duplicate.specialization,
        verdict: input.verdict,
      },
    };
  }

  return { ok: true, normalizedReasoning };
}

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
        lifecycle: c.lifecycle,
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
    "Assign or clear a ticket owner. Developers may self-assign unowned tickets from backlog, technical_analysis, or approved; privileged roles may reassign or clear stale assignees at any status.",
    {
      ticketId: TicketIdSchema.describe("Ticket ID (TKT-...)"),
      assigneeAgentId: AgentIdSchema.nullable().describe("Agent to assign, or null to clear the current assignee"),
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
      autoAssign: z.boolean().optional().describe("Auto-assign the calling non-system agent when entering in_progress without an assignee"),
      skipKnowledgeCapture: z.boolean().optional().describe("Skip automatic repo knowledge capture when transitioning to resolved or closed"),
      agentId: AgentIdSchema.describe("Requesting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ ticketId, status: targetStatus, comment, autoAssign, skipKnowledgeCapture, agentId, sessionId }) => {
      const c = await getContext();
      const resolvedCommitSha = targetStatus === "resolved"
        ? await getHead({ cwd: c.repoPath })
        : undefined;
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
        lifecycle: c.lifecycle,
      }, {
        ticketId,
        status: targetStatus as TicketStatusType,
        comment,
        autoAssign,
        skipKnowledgeCapture,
        commitSha: resolvedCommitSha,
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

      const authResult = resolveVerdictAuthorization(resolved.agentId, specialization, ticket.id, {
        db: c.db,
        config: c.config,
        role: resolved.role,
      });
      if (!authResult.authorized) {
        return errJson({
          denied: true,
          reason: authResult.reason ?? `Agent ${resolved.agentId} is not authorized for ${specialization}`,
        });
      }

      const reasoningValidation = validateVerdictReasoning({
        reasoning,
        verdict,
        specialization,
        ticketInternalId: ticket.id,
        agentId: resolved.agentId,
        db: c.db,
      });
      if (!reasoningValidation.ok) {
        return errJson({
          error: reasoningValidation.message,
          ...(reasoningValidation.data ?? {}),
        });
      }

      const modelVoterCapValidation = validateReviewerModelVoterCap({
        ticketInternalId: ticket.id,
        agentId: resolved.agentId,
        db: c.db,
        maxVotersPerModel: c.config?.governance?.modelDiversity?.maxVotersPerModel ?? 3,
      });
      if (!modelVoterCapValidation.ok) {
        return errJson({
          error: modelVoterCapValidation.message,
          ...(modelVoterCapValidation.data ?? {}),
        });
      }

      const now = new Date().toISOString();
      const stored = queries.insertReviewVerdict(c.db, {
        ticketId: ticket.id,
        agentId: resolved.agentId,
        sessionId: resolved.sessionId,
        specialization,
        verdict,
        reasoning: reasoningValidation.normalizedReasoning,
        createdAt: now,
      });
      queries.updateTicket(c.db, ticket.id, {});
      const verdictRows = queries.getActiveReviewVerdicts(c.db, ticket.id);
      const govOpts = buildGovernanceOptions(c.config?.governance, verdictRows, (aid) => {
        const a = queries.getAgent(c.db, aid);
        return a ? { roleId: a.roleId, provider: a.provider, model: a.model } : undefined;
      }, ticket.severity);

      const consensus = buildTicketConsensusReport({
        ticketId,
        verdictRows,
        config: c.config?.ticketQuorum,
        transition: transition ?? inferConsensusTransitionForTicketStatus(ticket.status as TicketStatusType),
        governance: govOpts,
      });

      recordDashboardEvent(c.db, c.repoId, {
        type: "ticket_verdict_submitted",
        data: {
          ticketId,
          specialization: stored.specialization,
          verdict: stored.verdict,
          agentId: stored.agentId,
          sessionId: stored.sessionId,
          transition: transition ?? inferConsensusTransitionForTicketStatus(ticket.status as TicketStatusType),
          responded: consensus.counts.responded,
          requiredPasses: consensus.requiredPasses,
          blockedByVeto: consensus.blockedByVeto,
          advisoryReady: consensus.advisoryReady,
        },
      });

      let autoAdvanced: { previousStatus: string; status: string } | null = null;
      const ticketTags = parseStringArrayJson(ticket.tagsJson, { maxItems: 25, maxItemLength: 64 });
      const excludedTags = c.config?.governance?.autoAdvanceExcludedTags ?? DEFAULT_AUTO_ADVANCE_EXCLUDED_TAGS;
      const hasExcludedTag = excludedTags.length > 0 && ticketTags.some((tag) => excludedTags.includes(tag));
      if (hasExcludedTag) {
        const matchedTag = ticketTags.find((tag) => excludedTags.includes(tag));
        recordDashboardEvent(c.db, c.repoId, {
          type: "auto_advance_skipped",
          data: {
            ticketId,
            reason: "excluded_tag",
            matchedTag,
            tags: ticketTags,
          },
        });
      }
      if (consensus.advisoryReady && c.config?.governance?.autoAdvance !== false && !hasExcludedTag) {
        const target = GATED_ADVANCE_TARGET[ticket.status as TicketStatusType];
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
            lifecycle: c.lifecycle,
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

      // Auto-spawn repair ticket on veto
      let repairSpawned: { ticketId: string } | null = null;
      if (consensus.blockedByVeto && c.config?.repairSpawner?.enabled) {
        const vetoReasons = consensus.vetoes
          .map((v) => `${v.specialization}: ${v.reasoning ?? "no reasoning"}`)
          .join("; ");
        const spawnResult = await spawnRepairTicket(
          {
            db: c.db,
            repoId: c.repoId,
            repoPath: c.repoPath,
            insight: c.insight,
            ticketQuorum: c.config?.ticketQuorum,
            governance: c.config?.governance,
            bus: c.bus,
            refreshTicketSearch: () => c.searchRouter?.rebuildTicketFts?.(c.repoId),
            lifecycle: c.lifecycle,
            system: true,
            actorLabel: "repair:council-veto",
          },
          {
            type: "council_veto",
            parentTicketId: ticketId,
            parentTicketTitle: ticket.title,
            reason: vetoReasons,
            sourceSpecializations: consensus.vetoes.map((v) => v.specialization),
            affectedPaths: parseStringArrayJson(ticket.affectedPathsJson, { maxItems: 100, maxItemLength: 500 }),
            severity: ticket.severity,
          },
          c.config.repairSpawner,
        );
        if (spawnResult.spawned && spawnResult.ticketId) {
          repairSpawned = { ticketId: spawnResult.ticketId };
        }
      }

      return okJson({
        ticketId,
        verdictAuthorizedBy: authResult.authorizedBy,
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
        repairSpawned,
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

      const verdictRows = queries.getActiveReviewVerdicts(c.db, ticket.id);
      const govOpts = buildGovernanceOptions(c.config?.governance, verdictRows, (aid) => {
        const a = queries.getAgent(c.db, aid);
        return a ? { roleId: a.roleId, provider: a.provider, model: a.model } : undefined;
      }, ticket.severity);

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
      if (!result.ok) return errService(result);

      // Soft limit: warn when relatedTo edges exceed recommended threshold
      const MAX_RELATED_TO = 3;
      let warning: string | null = null;
      if (relationType === "relates_to") {
        const fromTicket = queries.getTicketByTicketId(c.db, fromTicketId, c.repoId);
        if (fromTicket) {
          const countResult = c.db
            .select({ count: sql<number>`count(*)` })
            .from(tables.ticketDependencies)
            .where(and(
              or(
                eq(tables.ticketDependencies.fromTicketId, fromTicket.id),
                eq(tables.ticketDependencies.toTicketId, fromTicket.id),
              ),
              eq(tables.ticketDependencies.relationType, "relates_to"),
            ))
            .get();
          const totalRelated = countResult?.count ?? 0;
          if (totalRelated > MAX_RELATED_TO) {
            warning = `Ticket ${fromTicketId} now has ${totalRelated} relatedTo edges `
              + `(recommended max: ${MAX_RELATED_TO}). `
              + `Consider if this relationship adds scheduling or blocking value. `
              + `Use "blocks" for true dependencies.`;
          }
        }
      }

      return okJson({ ...result.data, ...(warning ? { warning } : {}) });
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

  // ─── list_verdicts ─────────────────────────────────────────
  server.tool(
    "list_verdicts",
    "List an agent's submitted council verdicts (active only, across tickets)",
    {
      agentId: AgentIdSchema.describe("Your agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
      targetAgentId: AgentIdSchema.optional().describe("Agent to query (defaults to caller)"),
      ticketId: TicketIdSchema.optional().describe("Filter by ticket ID"),
      specialization: z.string().optional().describe("Filter by specialization"),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async ({ agentId, sessionId, targetAgentId, ticketId, specialization, limit }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return errText(result.error);
      const resolved = result.agent;

      const access = checkToolAccess("list_tickets", resolved.role, resolved.trustTier);
      if (!access.allowed) return errJson({ denied: true, reason: access.reason });

      const queryAgentId = targetAgentId ?? resolved.agentId;
      const verdicts = queries.listVerdictsByAgent(c.db, c.repoId, queryAgentId, {
        ticketId,
        specialization,
        limit,
      });

      return okJson({ agentId: queryAgentId, count: verdicts.length, verdicts });
    },
  );

  // ─── prune_stale_relations ──────────────────────────────────
  server.tool(
    "prune_stale_relations",
    "List and optionally remove relatedTo dependency edges on tickets resolved more than N days ago. Use dryRun=true to preview.",
    {
      dryRun: z.boolean().default(true).describe("Preview without deleting"),
      olderThanDays: z.number().int().min(1).max(90).default(7).describe("Only prune edges on tickets resolved more than this many days ago"),
      agentId: AgentIdSchema.describe("Requesting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ dryRun, olderThanDays, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return errText(result.error);
      const resolved = result.agent;

      const access = checkToolAccess("unlink_tickets", resolved.role, resolved.trustTier);
      if (!access.allowed) return errJson({ denied: true, reason: access.reason });

      const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();

      // Find relatedTo edges where the source ticket is resolved and older than cutoff
      const staleEdges = c.db
        .select({
          depId: tables.ticketDependencies.id,
          fromTicketId: tables.ticketDependencies.fromTicketId,
          toTicketId: tables.ticketDependencies.toTicketId,
          fromTicketExtId: sql<string>`ft.ticket_id`,
          toTicketExtId: sql<string>`tt.ticket_id`,
          fromStatus: sql<string>`ft.status`,
          toStatus: sql<string>`tt.status`,
        })
        .from(tables.ticketDependencies)
        .innerJoin(
          sql`tickets ft`,
          sql`ft.id = ${tables.ticketDependencies.fromTicketId}`,
        )
        .innerJoin(
          sql`tickets tt`,
          sql`tt.id = ${tables.ticketDependencies.toTicketId}`,
        )
        .where(and(
          eq(tables.ticketDependencies.relationType, "relates_to"),
          sql`ft.status IN ('resolved', 'closed')`,
          sql`ft.updated_at < ${cutoff}`,
          sql`tt.status IN ('resolved', 'closed')`,
          sql`tt.updated_at < ${cutoff}`,
        ))
        .all();

      let pruned = 0;
      if (!dryRun && staleEdges.length > 0) {
        c.db.run(sql`BEGIN IMMEDIATE`);
        try {
          for (const edge of staleEdges) {
            c.db.delete(tables.ticketDependencies)
              .where(eq(tables.ticketDependencies.id, edge.depId))
              .run();
            pruned++;
          }
          c.db.run(sql`COMMIT`);
        } catch (err) {
          c.db.run(sql`ROLLBACK`);
          throw err;
        }
      }

      return okJson({
        dryRun,
        olderThanDays,
        prunable: staleEdges.length,
        pruned,
        edges: staleEdges.map((e) => ({
          fromTicketId: e.fromTicketExtId,
          toTicketId: e.toTicketExtId,
          fromStatus: e.fromStatus,
          toStatus: e.toStatus,
        })),
      });
    },
  );
}

// Response helpers imported from ./response-helpers.js
