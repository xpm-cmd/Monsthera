import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import {
  AgentIdSchema,
  SessionIdSchema,
  TicketIdSchema,
} from "../core/input-hardening.js";
import { resolveAgent } from "./resolve-agent.js";
import { checkToolAccess } from "../trust/tiers.js";
import { okJson, errText, errJson } from "./response-helpers.js";
import {
  createTicketRecord,
  linkTicketsRecord,
} from "../tickets/service.js";
import { validateDAG, type DAGEdge } from "../workflows/dag-validator.js";
import type { ProposedTask, DecompositionResult } from "../workflows/decompose-types.js";

type GetContext = () => Promise<AgoraContext>;

const MAX_TICKETS = 8;

const ProposedTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  affectedPaths: z.array(z.string().max(500)).max(50).default([]),
  tags: z.array(z.string().max(64)).max(25).default([]),
  severity: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  priority: z.number().int().min(0).max(10).default(5),
  rationale: z.string().min(1).max(1000),
  dependsOn: z.array(z.number().int().min(0)).default([]),
});

export function registerDecomposeTools(server: McpServer, getContext: GetContext): void {
  // ─── decompose_goal ──────────────────────────────────────────
  server.tool(
    "decompose_goal",
    "Validate and optionally persist a structured goal decomposition. The calling agent provides proposed tasks with dependencies; the tool validates the DAG, enforces maxTickets cap, and creates tickets + links if dryRun is false.",
    {
      goal: z.string().min(1).max(1000).describe("The high-level goal being decomposed"),
      scope: z.string().max(500).optional().describe("Optional path scope filter applied during analysis"),
      proposedTasks: z.array(ProposedTaskSchema).min(1).max(20).describe("Agent-generated tasks with dependency indices"),
      maxTickets: z.number().int().min(1).max(20).default(MAX_TICKETS).describe("Maximum number of tickets to create"),
      dryRun: z.boolean().default(true).describe("If true, validate only without creating tickets"),
      agentId: AgentIdSchema.describe("Requesting agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ goal, scope, proposedTasks, maxTickets, dryRun, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return errText(result.error);
      const resolved = result.agent;

      // Use run_workflow access as proxy — decompose is a planning tool
      const access = checkToolAccess("run_workflow", resolved.role, resolved.trustTier);
      if (!access.allowed) return errJson({ denied: true, reason: access.reason });

      const warnings: string[] = [];

      // Enforce maxTickets cap with explicit warning
      let tasks = proposedTasks as ProposedTask[];
      if (tasks.length > maxTickets) {
        warnings.push(
          `Proposed ${tasks.length} tasks but maxTickets is ${maxTickets}. Truncating to first ${maxTickets} tasks. ` +
          `Consider splitting into multiple decomposition rounds.`,
        );
        tasks = tasks.slice(0, maxTickets);
      }

      // Build and validate DAG
      const edges: DAGEdge[] = [];
      for (let i = 0; i < tasks.length; i++) {
        for (const dep of tasks[i]!.dependsOn) {
          // dependsOn[j] means task j blocks task i
          edges.push({ from: dep, to: i });
        }
      }

      const dagResult = validateDAG(edges, tasks.length);
      if (!dagResult.valid) {
        if (dagResult.boundsErrors && dagResult.boundsErrors.length > 0) {
          return errJson({
            error: "Invalid dependency indices in proposed tasks",
            boundsErrors: dagResult.boundsErrors,
          });
        }
        return errJson({
          error: "Proposed dependency graph contains cycles — cannot create tickets",
          cycleNodes: dagResult.cycleNodes,
          hint: "Remove or reverse dependencies to break the cycle",
        });
      }

      const dependencyGraph = edges.map((e) => ({ from: e.from, to: e.to }));

      // Validate each task has required fields
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i]!;
        if (!task.title || !task.description || !task.rationale) {
          return errJson({
            error: `Task ${i} is missing required fields (title, description, rationale)`,
            taskIndex: i,
          });
        }
      }

      // Dry run: return validated result without persisting
      if (dryRun) {
        const decomposition: DecompositionResult = {
          goal,
          scope,
          proposedTasks: tasks,
          dependencyGraph,
          warnings,
          isDryRun: true,
        };
        return okJson(decomposition);
      }

      // Persist: create tickets and links
      const createdTicketIds: string[] = [];
      const ticketCtx = {
        db: c.db,
        repoId: c.repoId,
        repoPath: c.repoPath,
        insight: c.insight,
        ticketQuorum: c.config?.ticketQuorum,
        governance: c.config?.governance,
        bus: c.bus,
        refreshTicketSearch: () => c.searchRouter?.rebuildTicketFts?.(c.repoId),
        lifecycle: c.lifecycle,
      };

      for (const task of tasks) {
        const createResult = await createTicketRecord(ticketCtx, {
          title: task.title,
          description: `${task.description}\n\n**Rationale:** ${task.rationale}\n\n*Generated by decompose_goal for: "${goal}"*`,
          severity: task.severity,
          priority: task.priority,
          tags: [...task.tags, "decomposed"],
          affectedPaths: task.affectedPaths,
          agentId,
          sessionId,
        });

        if (!createResult.ok) {
          warnings.push(`Failed to create ticket for "${task.title}": ${createResult.message}`);
          createdTicketIds.push("FAILED");
          continue;
        }

        createdTicketIds.push(createResult.data.ticketId as string);
      }

      // Wire dependencies
      for (const edge of edges) {
        const fromTicketId = createdTicketIds[edge.from];
        const toTicketId = createdTicketIds[edge.to];
        if (!fromTicketId || !toTicketId || fromTicketId === "FAILED" || toTicketId === "FAILED") {
          warnings.push(`Skipped dependency link: task ${edge.from} -> task ${edge.to} (ticket creation failed)`);
          continue;
        }

        const linkResult = linkTicketsRecord(ticketCtx, {
          fromTicketId,
          toTicketId,
          relationType: "blocks",
          agentId,
          sessionId,
        });

        if (!linkResult.ok) {
          warnings.push(`Failed to link ${fromTicketId} blocks ${toTicketId}: ${linkResult.message}`);
        }
      }

      const decomposition: DecompositionResult = {
        goal,
        scope,
        proposedTasks: tasks,
        dependencyGraph,
        warnings,
        isDryRun: false,
        createdTicketIds: createdTicketIds.filter((id) => id !== "FAILED"),
      };
      return okJson(decomposition);
    },
  );
}

// Response helpers imported from ./response-helpers.js
