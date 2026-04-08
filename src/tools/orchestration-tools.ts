import type { OrchestrationEventRepository, OrchestrationEventType } from "../orchestration/repository.js";
import { workId, agentId } from "../core/types.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { successResponse, errorResponse, requireString, optionalString, isErrorResponse, requireEnum, optionalNumber } from "./validation.js";

const VALID_EVENT_TYPES = new Set([
  "phase_advanced", "agent_spawned", "agent_completed",
  "dependency_blocked", "dependency_resolved", "guard_evaluated", "error_occurred",
]);

/** Returns the orchestration tool definitions for MCP ListTools */
export function orchestrationToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "log_event",
      description: "Log an orchestration event (phase change, agent lifecycle, dependency, guard, or error).",
      inputSchema: {
        type: "object" as const,
        properties: {
          workId: { type: "string", description: "Work article ID" },
          eventType: {
            type: "string",
            description: "Event type",
            enum: [...VALID_EVENT_TYPES],
          },
          details: { type: "object", description: "Event details" },
          agentId: { type: "string", description: "Agent ID (optional)" },
        },
        required: ["workId", "eventType", "details"],
      },
    },
    {
      name: "get_events",
      description: "Get orchestration events, optionally filtered by work ID or event type.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workId: { type: "string", description: "Filter by work article ID" },
          eventType: { type: "string", description: "Filter by event type" },
          limit: { type: "number", description: "Max events to return (default 50)" },
        },
      },
    },
  ];
}

/** Handle an orchestration tool call */
export async function handleOrchestrationTool(
  name: string,
  args: Record<string, unknown>,
  repo: OrchestrationEventRepository,
): Promise<ToolResponse> {
  switch (name) {
    case "log_event": {
      const wid = requireString(args, "workId");
      if (isErrorResponse(wid)) return wid;
      const eventType = requireString(args, "eventType");
      if (isErrorResponse(eventType)) return eventType;
      const eventTypeErr = requireEnum(eventType, VALID_EVENT_TYPES, "eventType");
      if (eventTypeErr) return eventTypeErr;
      const aid = optionalString(args, "agentId");
      if (isErrorResponse(aid)) return aid;
      const details = args.details;
      if (typeof details !== "object" || details === null || Array.isArray(details)) {
        return errorResponse("VALIDATION_FAILED", `"details" is required and must be an object`);
      }
      const result = await repo.logEvent({
        workId: workId(wid),
        eventType: eventType as OrchestrationEventType,
        agentId: aid ? agentId(aid) : undefined,
        details: details as Record<string, unknown>,
      });
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "get_events": {
      const wid = optionalString(args, "workId");
      if (isErrorResponse(wid)) return wid;
      const eventType = optionalString(args, "eventType");
      if (isErrorResponse(eventType)) return eventType;
      const limitVal = optionalNumber(args, "limit", 1, 1000);
      if (isErrorResponse(limitVal)) return limitVal;
      const limit = limitVal ?? 50;

      if (wid) {
        const result = await repo.findByWorkId(workId(wid));
        if (!result.ok) return errorResponse(result.error.code, result.error.message);
        return successResponse(result.value);
      }
      if (eventType) {
        const evtErr = requireEnum(eventType, VALID_EVENT_TYPES, "eventType");
        if (evtErr) return evtErr;
        const result = await repo.findByType(eventType as OrchestrationEventType);
        if (!result.ok) return errorResponse(result.error.code, result.error.message);
        return successResponse(result.value);
      }
      const result = await repo.findRecent(limit);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
