import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import { AgentIdSchema, SessionIdSchema } from "../core/input-hardening.js";
import * as queries from "../db/queries.js";
import { resolveAgent } from "./resolve-agent.js";
import { getToolRunner } from "./tool-runner.js";
import { BUILTIN_WORKFLOW_NAMES, getBuiltInWorkflow, isBuiltInWorkflowName } from "../workflows/builtins.js";
import { runWorkflow } from "../workflows/engine.js";
import { findCustomWorkflow, loadCustomWorkflows, type LoadedCustomWorkflow } from "../workflows/loader.js";
import type { ReviewerResolution, WorkflowResult, WorkflowSpec } from "../workflows/types.js";
import { loadRepoAgentCatalog } from "../repo-agents/catalog.js";
import { HEARTBEAT_TIMEOUT_MS } from "../core/constants.js";

type GetContext = () => Promise<AgoraContext>;

const WorkflowParamsSchema = z.record(z.string(), z.unknown()).default({});

interface LiveReviewerCandidate {
  agentId: string;
  agentName: string;
  roleId: string;
  sessionId: string;
}

export function registerWorkflowTools(server: McpServer, getContext: GetContext): void {
  server.tool(
    "run_workflow",
    "Execute a sequential workflow by name with static parameter mapping and per-step trust enforcement.",
    {
      name: z.string().trim().min(1).describe("Workflow name (built-in or custom:<name>)"),
      params: WorkflowParamsSchema.describe("Workflow parameters"),
      agentId: AgentIdSchema.describe("Agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ name, params, agentId, sessionId }) => {
      const c = await getContext();
      const actor = resolveAgent(c, agentId, sessionId);
      if (!actor.ok) {
        return {
          content: [{ type: "text" as const, text: actor.error }],
          isError: true,
        };
      }

      const runner = getToolRunner(server);
      const customWorkflows = await loadCustomWorkflows(c.repoPath, {
        validateTool: (toolName) => runner.has(toolName),
      });
      for (const warning of customWorkflows.warnings) {
        c.insight.warn(`Workflow warning in ${warning.filePath}: ${warning.message}`);
      }

      const spec = resolveWorkflowSpec(name, customWorkflows.workflows);
      if (!spec) {
        const missing = buildMissingWorkflowResult(
          name,
          params,
          customWorkflows.workflows.map((workflow) => workflow.name),
        );
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(missing, null, 2),
          }],
          isError: true,
        };
      }

      const result = await runWorkflow(
        spec,
        {
          runner,
          actor: { agentId, sessionId },
          workflowName: spec.name,
          loadReviewVerdicts: async (ticketId) => {
            const ticket = queries.getTicketByTicketId(c.db, ticketId, c.repoId);
            if (!ticket) return null;
            return queries.getActiveReviewVerdicts(c.db, ticket.id);
          },
          sendCoordination: async (request) => {
            c.bus.send({
              from: agentId,
              to: request.targetAgentId ?? null,
              type: "broadcast",
              payload: {
                kind: "review_request",
                ticketId: request.ticketId,
                roles: request.roles,
                workflowName: request.workflowName,
                stepKey: request.stepKey,
                requestedBy: request.requestedBy,
                timeoutSeconds: request.timeoutSeconds,
              },
            });
          },
          resolveReviewers: async (roles, ticketId) => {
            const catalog = await loadRepoAgentCatalog(c.repoPath);
            const liveSessions = queries.getLiveSessions(
              c.db,
              new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString(),
            );
            const ticket = queries.getTicketByTicketId(c.db, ticketId, c.repoId);
            const resolutions = resolveReviewerAssignments({
              roles,
              availableReviewRoles: catalog.availableReviewRoles,
              liveSessions,
              getAgent: (reviewerAgentId) => queries.getAgent(c.db, reviewerAgentId),
            });

            if (ticket) {
              for (const resolution of resolutions) {
                if (resolution.status !== "resolved" || !resolution.agentId) continue;
                queries.upsertCouncilAssignment(c.db, {
                  ticketId: ticket.id,
                  agentId: resolution.agentId,
                  specialization: resolution.specialization,
                  assignedByAgentId: agentId,
                  assignedAt: new Date().toISOString(),
                });
              }
            }

            return resolutions;
          },
        },
        params,
      );

      c.insight.info(`Workflow ${name} finished with status ${result.status}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
        ...(result.status === "failed" ? { isError: true } : {}),
      };
    },
  );
}

function resolveWorkflowSpec(
  name: string,
  customWorkflows: LoadedCustomWorkflow[],
): WorkflowSpec | null {
  if (isBuiltInWorkflowName(name)) {
    return getBuiltInWorkflow(name);
  }

  return findCustomWorkflow(customWorkflows, name)?.spec ?? null;
}

function buildMissingWorkflowResult(
  name: string,
  params: Record<string, unknown>,
  customWorkflowNames: string[],
): WorkflowResult {
  const availableNames = [...BUILTIN_WORKFLOW_NAMES, ...customWorkflowNames];
  return {
    name,
    description: "",
    status: "failed",
    params,
    steps: [{
      key: "__workflow__",
      tool: "run_workflow",
      status: "failed",
      durationMs: 0,
      errorCode: "workflow_not_found",
      message: availableNames.length > 0
        ? `Workflow ${name} was not found. Available workflows: ${availableNames.join(", ")}`
        : `Workflow ${name} was not found`,
    }],
    outputs: {},
    durationMs: 0,
  };
}

export function resolveReviewerAssignments(input: {
  roles: string[];
  availableReviewRoles: Record<string, string[]>;
  liveSessions: Array<{ id: string; agentId: string }>;
  getAgent: (agentId: string) => { name: string; roleId: string } | undefined;
}): ReviewerResolution[] {
  const liveCandidates = input.liveSessions.flatMap((session) => {
    const agent = input.getAgent(session.agentId);
    if (!agent || !canServeAsReviewer(agent.roleId)) return [];
    return [{
      agentId: session.agentId,
      agentName: agent.name,
      roleId: agent.roleId,
      sessionId: session.id,
    } satisfies LiveReviewerCandidate];
  });
  const reservedSessions = new Set<string>();

  return input.roles.map((role): ReviewerResolution => {
    const preferredNames = input.availableReviewRoles[role] ?? [];
    const resolved = pickReviewerCandidate(liveCandidates, preferredNames, reservedSessions);
    if (!resolved) {
      return {
        specialization: role,
        agentId: null,
        agentName: null,
        sessionId: null,
        status: "no_candidate",
      };
    }

    reservedSessions.add(resolved.sessionId);
    return {
      specialization: role,
      agentId: resolved.agentId,
      agentName: resolved.agentName,
      sessionId: resolved.sessionId,
      status: "resolved",
    };
  });
}

function canServeAsReviewer(roleId: string): boolean {
  return roleId === "reviewer" || roleId === "admin";
}

function pickReviewerCandidate(
  liveCandidates: LiveReviewerCandidate[],
  preferredNames: string[],
  reservedSessions: Set<string>,
): LiveReviewerCandidate | null {
  const preferred = pickCandidate(liveCandidates, preferredNames, reservedSessions, true)
    ?? pickCandidate(liveCandidates, preferredNames, reservedSessions, false);
  if (preferred) return preferred;

  return pickCandidate(liveCandidates, [], reservedSessions, true)
    ?? pickCandidate(liveCandidates, [], reservedSessions, false);
}

function pickCandidate(
  liveCandidates: LiveReviewerCandidate[],
  preferredNames: string[],
  reservedSessions: Set<string>,
  preferUnreserved: boolean,
): LiveReviewerCandidate | null {
  const pool = liveCandidates.filter((candidate) => (
    (!preferUnreserved || !reservedSessions.has(candidate.sessionId))
    && (preferredNames.length === 0 || preferredNames.includes(candidate.agentName))
  ));
  return pool[0] ?? null;
}
