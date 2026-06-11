import type { StatusReporter } from "../core/status.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { successResponse, errorResponse } from "./validation.js";

/** Returns the status tool definitions for MCP ListTools */
export function statusToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "status",
      description: "Returns system status, health, and subsystem info. When to use: As a session-start health check, or whenever results look wrong (missing articles, stale search) — confirm which repo and index you are talking to before debugging elsewhere.",
      inputSchema: {
        type: "object" as const,
        properties: {},
        required: [],
      },
    },
  ];
}

/** Handle a status tool call */
export async function handleStatusTool(
  name: string,
  _args: Record<string, unknown>,
  status: StatusReporter,
): Promise<ToolResponse> {
  switch (name) {
    case "status": {
      const result = await status.getStatusAsync();
      return successResponse(result);
    }
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
