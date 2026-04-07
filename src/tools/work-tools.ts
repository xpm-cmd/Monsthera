import type { WorkService } from "../work/service.js";
import { WorkPhase } from "../core/types.js";
import type { WorkPhase as WorkPhaseType } from "../core/types.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";

// ─── Private Helpers ──────────────────────────────────────────────────────────

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

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const VALID_PHASES: Set<string> = new Set(Object.values(WorkPhase));

const VALID_ENRICHMENT_STATUSES: Set<string> = new Set(["contributed", "skipped"]);
const VALID_REVIEW_STATUSES: Set<string> = new Set(["approved", "changes-requested"]);

/** Returns the work tool definitions for MCP ListTools */
export function workToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "create_work",
      description: "Create a new work article.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Work article title" },
          template: { type: "string", enum: ["feature", "bugfix", "refactor", "spike"], description: "Work template" },
          priority: { type: "string", enum: ["critical", "high", "medium", "low"], description: "Priority level" },
          author: { type: "string", description: "Author agent ID" },
          lead: { type: "string", description: "Lead agent ID" },
          tags: { type: "array", items: { type: "string" }, description: "Tags" },
          content: { type: "string", description: "Initial content (markdown)" },
        },
        required: ["title", "template", "priority", "author"],
      },
    },
    {
      name: "get_work",
      description: "Get a work article by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Work article ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "update_work",
      description: "Update an existing work article.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Work article ID (required)" },
          title: { type: "string", description: "New title" },
          priority: { type: "string", enum: ["critical", "high", "medium", "low"], description: "New priority" },
          lead: { type: "string", description: "New lead agent ID" },
          assignee: { type: "string", description: "New assignee agent ID" },
          tags: { type: "array", items: { type: "string" }, description: "New tags" },
          references: { type: "array", items: { type: "string" }, description: "New references" },
          codeRefs: { type: "array", items: { type: "string" }, description: "New code references" },
          content: { type: "string", description: "New content" },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_work",
      description: "Delete a work article by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Work article ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_work",
      description: "List work articles, optionally filtered by phase.",
      inputSchema: {
        type: "object" as const,
        properties: {
          phase: {
            type: "string",
            enum: ["planning", "enrichment", "implementation", "review", "done", "cancelled"],
            description: "Filter by phase",
          },
        },
      },
    },
    {
      name: "advance_phase",
      description: "Advance a work article to the next phase. Guards must pass.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Work article ID" },
          targetPhase: {
            type: "string",
            enum: ["planning", "enrichment", "implementation", "review", "done", "cancelled"],
            description: "Target phase",
          },
        },
        required: ["id", "targetPhase"],
      },
    },
    {
      name: "contribute_enrichment",
      description: "Record an enrichment contribution or skip for a role on a work article.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Work article ID" },
          role: { type: "string", description: "Enrichment role (e.g. architecture, security, testing)" },
          status: { type: "string", enum: ["contributed", "skipped"], description: "Contribution status" },
        },
        required: ["id", "role", "status"],
      },
    },
    {
      name: "assign_reviewer",
      description: "Assign a reviewer to a work article.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Work article ID" },
          agentId: { type: "string", description: "Reviewer agent ID" },
        },
        required: ["id", "agentId"],
      },
    },
    {
      name: "submit_review",
      description: "Submit a review outcome for a work article.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Work article ID" },
          agentId: { type: "string", description: "Reviewer agent ID" },
          status: { type: "string", enum: ["approved", "changes-requested"], description: "Review outcome" },
        },
        required: ["id", "agentId", "status"],
      },
    },
    {
      name: "add_dependency",
      description: "Add a blocking dependency to a work article.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Work article ID (the one being blocked)" },
          blockedById: { type: "string", description: "Work article ID of the blocker" },
        },
        required: ["id", "blockedById"],
      },
    },
    {
      name: "remove_dependency",
      description: "Remove a blocking dependency from a work article.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Work article ID" },
          blockedById: { type: "string", description: "Work article ID of the blocker to remove" },
        },
        required: ["id", "blockedById"],
      },
    },
  ];
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/** Handle a work tool call */
export async function handleWorkTool(
  name: string,
  args: Record<string, unknown>,
  service: WorkService,
): Promise<ToolResponse> {
  switch (name) {
    case "create_work": {
      const result = await service.createWork(args);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "get_work": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const result = await service.getWork(id);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "update_work": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const { id: _id, ...updateFields } = args;
      const result = await service.updateWork(id, updateFields);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "delete_work": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const result = await service.deleteWork(id);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse({ deleted: true });
    }
    case "list_work": {
      const phase = optionalString(args, "phase");
      if (isErrorResponse(phase)) return phase;
      if (phase !== undefined && !VALID_PHASES.has(phase)) {
        return errorResponse("VALIDATION_FAILED", `"${phase}" is not a valid phase`);
      }
      const result = await service.listWork(phase as WorkPhaseType);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "advance_phase": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const targetPhase = requireString(args, "targetPhase");
      if (isErrorResponse(targetPhase)) return targetPhase;
      if (!VALID_PHASES.has(targetPhase)) {
        return errorResponse("VALIDATION_FAILED", `"${targetPhase}" is not a valid phase`);
      }
      const result = await service.advancePhase(id, targetPhase as WorkPhaseType);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "contribute_enrichment": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const role = requireString(args, "role");
      if (isErrorResponse(role)) return role;
      const status = requireString(args, "status");
      if (isErrorResponse(status)) return status;
      if (!VALID_ENRICHMENT_STATUSES.has(status)) {
        return errorResponse("VALIDATION_FAILED", `"${status}" is not a valid enrichment status`);
      }
      const result = await service.contributeEnrichment(id, role, status as "contributed" | "skipped");
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "assign_reviewer": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const agentIdVal = requireString(args, "agentId");
      if (isErrorResponse(agentIdVal)) return agentIdVal;
      const result = await service.assignReviewer(id, agentIdVal);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "submit_review": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const agentIdVal = requireString(args, "agentId");
      if (isErrorResponse(agentIdVal)) return agentIdVal;
      const status = requireString(args, "status");
      if (isErrorResponse(status)) return status;
      if (!VALID_REVIEW_STATUSES.has(status)) {
        return errorResponse("VALIDATION_FAILED", `"${status}" is not a valid review status`);
      }
      const result = await service.submitReview(id, agentIdVal, status as "approved" | "changes-requested");
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "add_dependency": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const blockedById = requireString(args, "blockedById");
      if (isErrorResponse(blockedById)) return blockedById;
      const result = await service.addDependency(id, blockedById);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "remove_dependency": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const blockedById = requireString(args, "blockedById");
      if (isErrorResponse(blockedById)) return blockedById;
      const result = await service.removeDependency(id, blockedById);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
