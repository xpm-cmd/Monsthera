/**
 * MCP tool registration for `run_simulation` and `run_optimization`.
 */

import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgoraContext } from "../core/context.js";
import {
  runSimulation,
  runOptimizationLoop,
  type RunnerConfig,
  type ProgressEvent,
  type OptimizationConfig,
} from "../simulation/runner.js";
import type { WorkflowSpec } from "../workflows/types.js";
import type { WorkflowRuntime } from "../workflows/types.js";
import { getToolRunner } from "./tool-runner.js";
import * as queries from "../db/queries.js";
import { loadCustomWorkflows, findCustomWorkflow } from "../workflows/loader.js";
import { loadRepoAgentCatalog } from "../repo-agents/catalog.js";
import { HEARTBEAT_TIMEOUT_MS } from "../core/constants.js";
import { resolveReviewerAssignments } from "./workflow-tools.js";

type GetContext = () => Promise<AgoraContext>;

export function registerSimulationTools(server: McpServer, getContext: GetContext): void {
  server.tool(
    "run_simulation",
    "Run the Agora self-improvement simulation loop. Generates atomic tickets from the codebase, measures infrastructure quality in a sandbox, optionally executes real work, and persists KPI results as JSONL.",
    {
      targetCorpusSize: z.number().int().min(1).max(1000).default(200)
        .describe("Max tickets to generate (default 200)"),
      realWorkBatchSize: z.number().int().min(1).max(100).default(50)
        .describe("Max tickets to process in real work phase (default 50)"),
      skipRealWork: z.boolean().default(true)
        .describe("Skip Phase C real work execution (default true)"),
      phase: z.enum(["all", "A", "B", "C", "D", "E"]).default("all")
        .describe("Which phase to run: all, A (generate), B (sandbox), C (real work), D (persist), E (orchestrator)"),
      outputPath: z.string().default(".agora/simulation-results.jsonl")
        .describe("JSONL output path relative to repo root"),
      ticketTimeoutMs: z.number().int().min(10_000).max(600_000).default(120_000)
        .describe("Per-ticket workflow timeout in ms (default 120000)"),
    },
    async ({ targetCorpusSize, realWorkBatchSize, skipRealWork, phase, outputPath, ticketTimeoutMs }) => {
      try {
        const c = await getContext();
        const { resolve } = await import("node:path");

        const progressLog: string[] = [];
        const onProgress = (event: ProgressEvent) => {
          progressLog.push(`[sim] Phase ${event.phase}: ${event.message}`);
        };

        const config: RunnerConfig = {
          db: c.db,
          sqlite: c.sqlite,
          repoId: c.repoId,
          repoPath: c.repoPath,
          phase: phase as RunnerConfig["phase"],
          targetCorpusSize,
          realWorkBatchSize,
          skipRealWork,
          outputPath: resolve(c.repoPath, outputPath),
          onProgress,
        };

        // Wire up workflow runtime for Phase C when real work is enabled
        if (!skipRealWork) {
          const wf = await buildWorkflowConfig(server, c, ticketTimeoutMs);
          if (wf) {
            config.workflow = wf;
          } else {
            progressLog.push("[sim] Warning: developer-loop workflow not found, Phase C will use stub mode");
          }
        }

        const result = await runSimulation(config);

        const output = {
          runId: result.runId,
          phasesRun: result.phasesRun,
          corpusSize: result.corpus?.descriptors.length ?? 0,
          rejected: result.corpus?.rejections.length ?? 0,
          compositeScore: result.result?.compositeScore ?? null,
          deltas: result.result?.deltas ?? null,
          summary: result.summary,
          progressLog,
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(output),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: message, stack }),
          }],
        };
      }
    },
  );

  // ─── run_optimization ────────────────────────────────────
  server.tool(
    "run_optimization",
    "Run the iterative autoresearch optimization loop. Detects codebase issues, ranks by expected impact, tries each fix in an isolated git worktree, keeps improvements (delta > 0), reverts non-improvements. Produces cumulative KPI deltas.",
    {
      iterations: z.number().int().min(1).max(20).default(3)
        .describe("Number of optimization iterations (default 3)"),
      topK: z.number().int().min(1).max(50).default(5)
        .describe("Top-K candidates to try per iteration (default 5)"),
      testCommand: z.string().default("pnpm test")
        .describe("Test command to validate changes (default 'pnpm test')"),
      testTimeoutMs: z.number().int().min(10_000).max(600_000).default(120_000)
        .describe("Test timeout in ms (default 120000)"),
      outputPath: z.string().default(".agora/simulation-results.jsonl")
        .describe("JSONL output path relative to repo root"),
      ticketTimeoutMs: z.number().int().min(10_000).max(600_000).default(120_000)
        .describe("Per-ticket workflow timeout in ms (default 120000)"),
    },
    async ({ iterations, topK, testCommand, testTimeoutMs, outputPath, ticketTimeoutMs }) => {
      try {
        const c = await getContext();
        const { resolve } = await import("node:path");

        const progressLog: string[] = [];
        const onProgress = (event: { iteration: number; totalIterations: number; message: string }) => {
          progressLog.push(`[opt] [${event.iteration}/${event.totalIterations}] ${event.message}`);
        };

        const optConfig: OptimizationConfig = {
          db: c.db,
          sqlite: c.sqlite,
          repoId: c.repoId,
          repoPath: c.repoPath,
          iterations,
          topK,
          testCommand,
          testTimeoutMs,
          outputPath: resolve(c.repoPath, outputPath),
          onProgress,
        };

        // Wire up workflow runtime (same pattern as run_simulation)
        const wf = await buildWorkflowConfig(server, c, ticketTimeoutMs);
        if (wf) {
          optConfig.workflow = wf;
        } else {
          progressLog.push("[opt] Warning: developer-loop workflow not found, fixes will use marker mode");
        }

        const result = await runOptimizationLoop(optConfig);

        const output = {
          runId: result.runId,
          iterations: result.iterations,
          totalCandidates: result.totalCandidates,
          kept: result.kept,
          reverted: result.reverted,
          testFailed: result.testFailed,
          mergeFailed: result.mergeFailed,
          workflowFailed: result.workflowFailed,
          baselineComposite: result.baselineComposite,
          finalComposite: result.finalComposite,
          cumulativeDelta: result.cumulativeDelta,
          durationMs: result.durationMs,
          summary: result.summary,
          candidates: result.candidates.map((cr) => ({
            title: cr.descriptor.title,
            status: cr.status,
            baselineScore: cr.baselineScore,
            newScore: cr.newScore,
            delta: cr.delta,
            durationMs: cr.durationMs,
          })),
          progressLog,
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(output),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: message, stack }),
          }],
        };
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Shared workflow config builder (used by both tools)
// ---------------------------------------------------------------------------

async function buildWorkflowConfig(
  server: McpServer,
  c: AgoraContext,
  stepTimeoutMs: number,
): Promise<RunnerConfig["workflow"] | null> {
  const runner = getToolRunner(server);
  const customWorkflows = await loadCustomWorkflows(c.repoPath, {
    validateTool: (toolName) => runner.has(toolName),
  });
  const devLoop = findCustomWorkflow(customWorkflows.workflows, "developer-loop");
  if (!devLoop) return null;

  const councilLoop = findCustomWorkflow(customWorkflows.workflows, "council-loop");

  const simAgentId = `sim-runner-${Date.now().toString(36)}`;
  const simSessionId = `sim-session-${Date.now().toString(36)}`;
  queries.upsertAgent(c.db, {
    id: simAgentId,
    name: "simulation-runner",
    type: "claude-code",
    roleId: "developer",
    trustTier: "A",
    registeredAt: new Date().toISOString(),
  });
  queries.insertSession(c.db, {
    id: simSessionId,
    agentId: simAgentId,
    connectedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
  });

  const specs: Record<string, WorkflowSpec> = {
    "developer-loop": devLoop.spec,
  };
  if (councilLoop) {
    specs["council-loop"] = councilLoop.spec;
  }

  return {
    specs,
    runtime: {
      runner,
      actor: { agentId: simAgentId, sessionId: simSessionId },
      workflowName: "developer-loop",
      loadReviewVerdicts: async (ticketId) => {
        const ticket = queries.getTicketByTicketId(c.db, ticketId, c.repoId);
        if (!ticket) return null;
        return queries.getActiveReviewVerdicts(c.db, ticket.id);
      },
      sendCoordination: async (request) => {
        c.bus.send({
          from: simAgentId,
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
        return resolveReviewerAssignments({
          roles,
          availableReviewRoles: catalog.availableReviewRoles,
          liveSessions,
          requireDistinctModels: (c.config?.governance?.modelDiversity?.strict ?? true)
            && ticket?.severity !== "critical",
          maxReviewersPerModel: c.config?.governance?.modelDiversity?.maxVotersPerModel ?? 3,
          getAgent: (reviewerAgentId) => queries.getAgent(c.db, reviewerAgentId),
        });
      },
    } as WorkflowRuntime,
    stepTimeoutMs,
  };
}
