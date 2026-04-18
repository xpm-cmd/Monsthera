import type { OrchestrationService } from "../orchestration/service.js";
import type { WorkService } from "../work/service.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { successResponse, errorResponse, requireString, isErrorResponse } from "./validation.js";

export type { ToolDefinition, ToolResponse };

/** Returns the wave orchestration tool definitions for MCP ListTools */
export function waveToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "plan_wave",
      description:
        "List every active work article that is ready to advance to its next phase right now (all guards pass, no unresolved dependencies), plus the articles that are blocked and why. Read-only: does not mutate phase. Use before execute_wave, or as a triage scan for what to work on next. Enriched with title, template, priority, and assignee so agents can pick targets without additional get_work calls.",
      inputSchema: {
        type: "object" as const,
        properties: {
          autoAdvanceOnly: {
            type: "boolean",
            description: "When true, only include work whose template permits automated advancement. Default false.",
          },
        },
      },
    },
    {
      name: "execute_wave",
      description:
        "Plan a wave and then execute it: every ready article is advanced to its next phase in one call. Returns per-item outcomes (advanced or failed with reason). Use this when you have reviewed plan_wave and want to apply the whole wave. For a single article that failed a guard and needs a justified bypass, prefer advance_phase with skip_guard instead.",
      inputSchema: {
        type: "object" as const,
        properties: {
          autoAdvanceOnly: {
            type: "boolean",
            description: "When true, only plan/execute work whose template permits automated advancement. Default false.",
          },
        },
      },
    },
    {
      name: "evaluate_readiness",
      description:
        "Dry-run a phase advancement for a single work article: return the current phase, the next phase (if any), whether every guard passes, and the list of guards with individual pass/fail results. Read-only. Use before advance_phase to understand exactly which guard is blocking and whether skip_guard would be legitimate.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workId: { type: "string", description: "Work article ID" },
        },
        required: ["workId"],
      },
    },
  ];
}

/** Handle a wave orchestration tool call */
export async function handleWaveTool(
  name: string,
  args: Record<string, unknown>,
  orchestrationService: OrchestrationService,
  workService: WorkService,
): Promise<ToolResponse> {
  switch (name) {
    case "plan_wave": {
      const autoAdvanceOnly = args.autoAdvanceOnly === true;
      const planResult = await orchestrationService.planWave(
        autoAdvanceOnly ? { autoAdvanceOnly: true } : undefined,
      );
      if (!planResult.ok) return errorResponse(planResult.error.code, planResult.error.message);

      const workResult = await workService.listWork();
      if (!workResult.ok) return errorResponse(workResult.error.code, workResult.error.message);

      const workById = new Map(workResult.value.map((article) => [String(article.id), article]));
      const ready = planResult.value.items.map((item) => {
        const article = workById.get(item.workId);
        return {
          workId: item.workId,
          title: article?.title ?? item.workId,
          from: item.from,
          to: item.to,
          template: article?.template,
          priority: article?.priority,
          assignee: article?.assignee,
          updatedAt: article?.updatedAt,
        };
      });
      const blocked = planResult.value.blockedItems.map((item) => {
        const article = workById.get(item.workId);
        return {
          workId: item.workId,
          title: article?.title ?? item.workId,
          phase: article?.phase,
          template: article?.template,
          priority: article?.priority,
          assignee: article?.assignee,
          reason: item.reason,
        };
      });

      return successResponse({
        autoAdvanceOnly,
        ready,
        blocked,
        summary: { readyCount: ready.length, blockedCount: blocked.length },
      });
    }

    case "execute_wave": {
      const autoAdvanceOnly = args.autoAdvanceOnly === true;
      const planResult = await orchestrationService.planWave(
        autoAdvanceOnly ? { autoAdvanceOnly: true } : undefined,
      );
      if (!planResult.ok) return errorResponse(planResult.error.code, planResult.error.message);

      const executionResult = await orchestrationService.executeWave(planResult.value);
      if (!executionResult.ok) return errorResponse(executionResult.error.code, executionResult.error.message);

      return successResponse({
        autoAdvanceOnly,
        summary: {
          plannedCount: planResult.value.items.length,
          advancedCount: executionResult.value.advanced.length,
          failedCount: executionResult.value.failed.length,
        },
        advanced: executionResult.value.advanced.map((item) => ({
          workId: item.workId,
          from: item.from,
          to: item.to,
          title: item.article.title,
          phase: item.article.phase,
        })),
        failed: executionResult.value.failed,
      });
    }

    case "evaluate_readiness": {
      const id = requireString(args, "workId");
      if (isErrorResponse(id)) return id;
      const result = await orchestrationService.evaluateReadiness(id);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }

    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
