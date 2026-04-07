import type { OrchestrationEventRepository, OrchestrationEventType } from "../orchestration/repository.js";
import { workId, agentId } from "../core/types.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";

const VALID_EVENT_TYPES = new Set([
  "phase_advanced", "agent_spawned", "agent_completed",
  "dependency_blocked", "dependency_resolved", "guard_evaluated", "error_occurred",
]);

/** Helper to build a success response */
function successResponse(data: unknown): ToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Helper to build an error response */
function errorResponse(code: string, message: string): ToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: code, message }) }],
    isError: true,
  };
}

/** Extract a required string arg, returning an error response if missing or wrong type */
function requireString(args: Record<string, unknown>, key: string): string | ToolResponse {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    return errorResponse("VALIDATION_FAILED", `"${key}" is required and must be a non-empty string`);
  }
  return value;
}

/** Extract an optional string arg, returning an error response if present but wrong type */
function optionalString(args: Record<string, unknown>, key: string): string | undefined | ToolResponse {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    return errorResponse("VALIDATION_FAILED", `"${key}" must be a string`);
  }
  return value;
}

/** Type guard: is the value a ToolResponse (i.e., an error from arg extraction)? */
function isErrorResponse(value: unknown): value is ToolResponse {
  return typeof value === "object" && value !== null && "isError" in value;
}

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
      if (!VALID_EVENT_TYPES.has(eventType)) {
        return errorResponse("VALIDATION_FAILED", `Invalid eventType "${eventType}". Must be one of: ${[...VALID_EVENT_TYPES].join(", ")}`);
      }
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
      const limit = typeof args.limit === "number" ? args.limit : 50;

      if (wid) {
        const result = await repo.findByWorkId(workId(wid));
        if (!result.ok) return errorResponse(result.error.code, result.error.message);
        return successResponse(result.value);
      }
      if (eventType) {
        if (!VALID_EVENT_TYPES.has(eventType)) {
          return errorResponse("VALIDATION_FAILED", `Invalid eventType "${eventType}". Must be one of: ${[...VALID_EVENT_TYPES].join(", ")}`);
        }
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
