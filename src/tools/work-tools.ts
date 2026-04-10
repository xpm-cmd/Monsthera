import type { WorkService } from "../work/service.js";
import type { StructureService, NeighborResult } from "../structure/service.js";
import { VALID_PHASES } from "../core/types.js";
import type { WorkPhase as WorkPhaseType } from "../core/types.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { successResponse, errorResponse, requireString, optionalString, isErrorResponse, requireEnum } from "./validation.js";

// ─── Tool Definitions ───────────────────────────────────────────────────��─────

const VALID_ENRICHMENT_STATUSES: Set<string> = new Set(["contributed", "skipped"]);
const VALID_REVIEW_STATUSES: Set<string> = new Set(["approved", "changes-requested"]);

/** Returns the work tool definitions for MCP ListTools */
export function workToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "create_work",
      description: "Create the work article that will act as the handoff contract for execution. Add objective, acceptance criteria, owners, references, and code refs as early as possible. Search sync happens automatically; use reindex_all only after bulk imports or recovery work.",
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
      description: "Open a work article by ID to inspect the current contract, lifecycle phase, blockers, ownership, and review state.",
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
      description: "Update an existing work article to tighten the contract before or during execution. Add owners, references, code refs, blockers, and review expectations as context becomes clear. Search sync happens automatically; manual reindex is not needed for normal edits.",
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
      description: "Delete a work article by ID. Search sync happens automatically; manual remove_from_index is only for repair flows.",
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
      description: "List work articles, optionally filtered by phase. Returns summaries (no content) with pagination. Use get_work to read full content.",
      inputSchema: {
        type: "object" as const,
        properties: {
          phase: {
            type: "string",
            enum: ["planning", "enrichment", "implementation", "review", "done", "cancelled"],
            description: "Filter by phase",
          },
          limit: { type: "number", description: "Max results (1-100, default 20)" },
          offset: { type: "number", description: "Skip N results (default 0)" },
        },
      },
    },
    {
      name: "advance_phase",
      description: "Advance a work article to the next phase only when the guards pass and the next owner or review gate is explicit.",
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
      description: "Record an enrichment contribution or an explicit skip for a specialist role on a work article.",
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
      description: "Assign a real reviewer to a work article so review becomes an explicit gate instead of an implied future step.",
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
      description: "Submit a review outcome for a work article to close or reopen the review gate explicitly.",
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
      description: "Add a blocking dependency to a work article so automation and humans can see why progress should wait.",
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
function formatWorkConnections(neighbors: NeighborResult): Record<string, unknown> {
  const references: { id: string; title: string; kind: string }[] = [];
  const referencedBy: { id: string; title: string; kind: string }[] = [];
  const dependencies: { id: string; title: string; direction: string }[] = [];
  const sharedTopics: { id: string; title: string; sharedTags: readonly string[] }[] = [];
  const codeLinks: string[] = [];

  for (const edge of neighbors.edges) {
    if (edge.neighborKind === "code") {
      codeLinks.push(edge.neighborId);
      continue;
    }
    if (edge.kind === "reference" && edge.direction === "outgoing") {
      references.push({ id: edge.neighborId, title: edge.neighborLabel, kind: edge.neighborKind });
    } else if (edge.kind === "reference" && edge.direction === "incoming") {
      referencedBy.push({ id: edge.neighborId, title: edge.neighborLabel, kind: edge.neighborKind });
    } else if (edge.kind === "dependency") {
      dependencies.push({ id: edge.neighborId, title: edge.neighborLabel, direction: edge.direction });
    } else if (edge.kind === "shared_tag") {
      sharedTopics.push({ id: edge.neighborId, title: edge.neighborLabel, sharedTags: edge.tags ?? [] });
    }
  }

  return {
    ...(references.length > 0 ? { references } : {}),
    ...(referencedBy.length > 0 ? { referencedBy } : {}),
    ...(dependencies.length > 0 ? { dependencies } : {}),
    ...(sharedTopics.length > 0 ? { sharedTopics } : {}),
    ...(codeLinks.length > 0 ? { codeLinks } : {}),
  };
}

export async function handleWorkTool(
  name: string,
  args: Record<string, unknown>,
  service: WorkService,
  structureService?: StructureService,
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
      if (structureService) {
        const neighbors = await structureService.getNeighbors(result.value.id, { limit: 10 });
        if (neighbors.ok) {
          const connections = formatWorkConnections(neighbors.value);
          if (Object.keys(connections).length > 0) {
            return successResponse({ ...result.value, connections });
          }
        }
      }
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
      if (phase !== undefined) {
        const enumErr = requireEnum(phase, VALID_PHASES, "phase");
        if (enumErr) return enumErr;
      }
      const rawLimit = typeof args.limit === "number" ? args.limit : 20;
      const limit = Math.max(1, Math.min(rawLimit, 100));
      const rawOffset = typeof args.offset === "number" ? args.offset : 0;
      const offset = Math.max(0, rawOffset);
      const result = await service.listWork(phase as WorkPhaseType);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      const total = result.value.length;
      const page = result.value.slice(offset, offset + limit);
      const summaries = page.map((w) => ({
        id: w.id,
        title: w.title,
        template: w.template,
        phase: w.phase,
        priority: w.priority,
        assignee: w.assignee,
        updatedAt: w.updatedAt,
      }));
      return successResponse({ total, limit, offset, items: summaries });
    }
    case "advance_phase": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const targetPhase = requireString(args, "targetPhase");
      if (isErrorResponse(targetPhase)) return targetPhase;
      const phaseErr = requireEnum(targetPhase, VALID_PHASES, "targetPhase");
      if (phaseErr) return phaseErr;
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
      const enrichErr = requireEnum(status, VALID_ENRICHMENT_STATUSES, "status");
      if (enrichErr) return enrichErr;
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
      const reviewErr = requireEnum(status, VALID_REVIEW_STATUSES, "status");
      if (reviewErr) return reviewErr;
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
