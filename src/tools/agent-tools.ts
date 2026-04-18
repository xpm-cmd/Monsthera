import type { AgentService } from "../agents/service.js";
import type { WorkService } from "../work/service.js";
import type { KnowledgeService } from "../knowledge/service.js";
import type { OrchestrationService } from "../orchestration/service.js";
import type { StatusReporter } from "../core/status.js";
import { deriveAgentExperience } from "../dashboard/agent-experience.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { successResponse, errorResponse, requireString, isErrorResponse } from "./validation.js";

export type { ToolDefinition, ToolResponse };

export interface AgentToolDeps {
  readonly agentsService: AgentService;
  readonly workService: WorkService;
  readonly knowledgeService: KnowledgeService;
  readonly orchestrationService: OrchestrationService;
  readonly status: StatusReporter;
  readonly autoAdvanceEnabled: boolean;
}

/** Returns the agent directory and diagnostics tool definitions for MCP ListTools */
export function agentToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "list_agents",
      description:
        "Return the derived agent directory: every agent inferred from work article authorship, leads, assignees, reviewers, and enrichment roles, with per-agent counts and a workspace-level summary. Use to discover who owns what and who is active before assigning reviewers or picking a lead.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "get_agent",
      description:
        "Return a single agent profile by ID with per-work touchpoints, current focus, and recent events. Use after list_agents when you need the full breakdown for handoff or review assignment.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Agent ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "get_agent_experience",
      description:
        "Return the workspace-level agent-experience snapshot: scores (overall, contract, context, ownership, review), coverage metrics, automation posture, search freshness, and ranked recommendations to improve token economy and handoff quality. Read-only; use for self-assessment or to decide what to improve next.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];
}

/** Handle an agent directory or diagnostics tool call */
export async function handleAgentTool(
  name: string,
  args: Record<string, unknown>,
  deps: AgentToolDeps,
): Promise<ToolResponse> {
  switch (name) {
    case "list_agents": {
      const result = await deps.agentsService.listAgents();
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse({
        generatedAt: result.value.generatedAt,
        summary: result.value.summary,
        agents: result.value.agents.map((agent) => ({
          id: agent.id,
          status: agent.status,
          roles: agent.roles,
          workCount: agent.workCount,
          activeWorkCount: agent.activeWorkCount,
          blockedWorkCount: agent.blockedWorkCount,
          authoredCount: agent.authoredCount,
          leadCount: agent.leadCount,
          assignedCount: agent.assignedCount,
          pendingReviewCount: agent.pendingReviewCount,
          lastActivityAt: agent.lastActivityAt,
        })),
      });
    }

    case "get_agent": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const result = await deps.agentsService.getAgent(id);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }

    case "get_agent_experience": {
      const [workResult, knowledgeResult, directoryResult, waveResult] = await Promise.all([
        deps.workService.listWork(),
        deps.knowledgeService.listArticles(),
        deps.agentsService.listAgents(),
        deps.orchestrationService.planWave(),
      ]);
      if (!workResult.ok) return errorResponse(workResult.error.code, workResult.error.message);
      if (!knowledgeResult.ok) return errorResponse(knowledgeResult.error.code, knowledgeResult.error.message);
      if (!directoryResult.ok) return errorResponse(directoryResult.error.code, directoryResult.error.message);
      if (!waveResult.ok) return errorResponse(waveResult.error.code, waveResult.error.message);

      const snapshot = deriveAgentExperience({
        workArticles: workResult.value,
        knowledgeCount: knowledgeResult.value.length,
        agentSummary: directoryResult.value.summary,
        status: deps.status.getStatus(),
        autoAdvanceEnabled: deps.autoAdvanceEnabled,
        waveSummary: {
          readyCount: waveResult.value.items.length,
          blockedCount: waveResult.value.blockedItems.length,
        },
      });
      return successResponse(snapshot);
    }

    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
