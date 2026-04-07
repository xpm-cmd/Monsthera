import type { StatusReporter } from "../core/status.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";

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

/** Returns the status tool definitions for MCP ListTools */
export function statusToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "status",
      description: "Returns system status, health, and subsystem info.",
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
      const result = status.getStatus();
      return successResponse(result);
    }
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
