import type { WorkService } from "../work/service.js";
import type { StructureService, NeighborResult } from "../structure/service.js";
import { VALID_PHASES, Priority } from "../core/types.js";
import type { WorkPhase as WorkPhaseType, Priority as PriorityType } from "../core/types.js";
import type { WorkArticle } from "../work/repository.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { successResponse, errorResponse, requireString, optionalString, isErrorResponse, requireEnum } from "./validation.js";

// ─── Tool Definitions ───────────────────────────────────────────────────��─────

const VALID_ENRICHMENT_STATUSES: Set<string> = new Set(["contributed", "skipped"]);
const VALID_REVIEW_STATUSES: Set<string> = new Set(["approved", "changes-requested"]);
const VALID_PRIORITIES: ReadonlySet<string> = new Set<string>(Object.values(Priority));

/** Returns the work tool definitions for MCP ListTools */
export function workToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "create_work",
      description: "Create the work article that will act as the handoff contract for execution. Add objective, acceptance criteria, owners, references, and code refs as early as possible so the contract is ready for pickup — fewer round-trips than create + update. Search sync happens automatically; use reindex_all only after bulk imports or recovery work.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Work article title" },
          template: { type: "string", enum: ["feature", "bugfix", "refactor", "spike"], description: "Work template" },
          priority: { type: "string", enum: ["critical", "high", "medium", "low"], description: "Priority level" },
          author: { type: "string", description: "Author agent ID" },
          lead: { type: "string", description: "Lead agent ID" },
          assignee: { type: "string", description: "Assignee agent ID (who will implement or own execution)" },
          tags: { type: "array", items: { type: "string" }, description: "Tags" },
          references: { type: "array", items: { type: "string" }, description: "Knowledge article IDs or slugs this work builds on" },
          codeRefs: { type: "array", items: { type: "string" }, description: "Code references (file paths, optionally with line ranges)" },
          content: { type: "string", description: "Initial content (markdown). Include ## Objective and ## Acceptance Criteria so guards pass." },
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
      description: "List work articles with optional AND-combined filters. Returns summaries (no content) with pagination; use get_work to read full content. Filters: `phase`, `priority`, `assignee` (agent id), `tag` (single tag; matches if the work carries it), `blocked` (true = has unresolved dependencies, false = clear to pick up).",
      inputSchema: {
        type: "object" as const,
        properties: {
          phase: {
            type: "string",
            enum: ["planning", "enrichment", "implementation", "review", "done", "cancelled"],
            description: "Filter by phase",
          },
          priority: {
            type: "string",
            enum: ["critical", "high", "medium", "low"],
            description: "Filter by priority",
          },
          assignee: { type: "string", description: "Filter by assignee agent id" },
          tag: { type: "string", description: "Filter by a single tag (work must carry it)" },
          blocked: {
            type: "boolean",
            description: "Filter by blocked state — true returns only work with unresolved `blockedBy` dependencies, false returns only unblocked work",
          },
          limit: { type: "number", description: "Max results (1-100, default 20)" },
          offset: { type: "number", description: "Skip N results (default 0)" },
        },
      },
    },
    {
      name: "advance_phase",
      description: "Advance a work article to the next phase only when the guards pass and the next owner or review gate is explicit. Pass `reason` when cancelling; use `skip_guard: { reason }` for auditable guard bypass in legitimate edge cases.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Work article ID" },
          targetPhase: {
            type: "string",
            enum: ["planning", "enrichment", "implementation", "review", "done", "cancelled"],
            description: "Target phase",
          },
          reason: {
            type: "string",
            description: "Required when targetPhase is 'cancelled'. Recorded on the new phase-history entry.",
          },
          skip_guard: {
            type: "object",
            description: "Auditable escape hatch that bypasses failing guards (not structural transition validity). The reason is recorded on the new phase-history entry alongside the names of the skipped guards.",
            properties: {
              reason: { type: "string", description: "Required justification for bypassing the guard(s)." },
            },
            required: ["reason"],
            additionalProperties: false,
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

interface ListWorkFilters {
  readonly priority?: PriorityType;
  readonly assignee?: string;
  readonly tag?: string;
  readonly blocked?: boolean;
}

/**
 * AND-combined in-memory filter for list_work. Applied after the repo-level
 * phase filter so agents can mix criteria freely without per-combination
 * repo methods.
 */
function filterWorkArticles(
  articles: readonly WorkArticle[],
  filters: ListWorkFilters,
): WorkArticle[] {
  return articles.filter((w) => {
    if (filters.priority !== undefined && w.priority !== filters.priority) return false;
    if (filters.assignee !== undefined && w.assignee !== filters.assignee) return false;
    if (filters.tag !== undefined && !w.tags.includes(filters.tag)) return false;
    if (filters.blocked === true && w.blockedBy.length === 0) return false;
    if (filters.blocked === false && w.blockedBy.length > 0) return false;
    return true;
  });
}

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
      const priority = optionalString(args, "priority");
      if (isErrorResponse(priority)) return priority;
      if (priority !== undefined) {
        const enumErr = requireEnum(priority, VALID_PRIORITIES, "priority");
        if (enumErr) return enumErr;
      }
      const assignee = optionalString(args, "assignee");
      if (isErrorResponse(assignee)) return assignee;
      const tag = optionalString(args, "tag");
      if (isErrorResponse(tag)) return tag;
      let blocked: boolean | undefined;
      if (args.blocked !== undefined) {
        if (typeof args.blocked !== "boolean") {
          return errorResponse("VALIDATION_FAILED", `"blocked" must be a boolean`);
        }
        blocked = args.blocked;
      }
      const rawLimit = typeof args.limit === "number" ? args.limit : 20;
      const limit = Math.max(1, Math.min(rawLimit, 100));
      const rawOffset = typeof args.offset === "number" ? args.offset : 0;
      const offset = Math.max(0, rawOffset);
      const result = await service.listWork(phase as WorkPhaseType | undefined);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);

      // Apply AND-combined in-memory filters. The phase filter is already
      // satisfied by the repo-level findByPhase above; the rest are applied
      // here so agents can mix them without repo-side combinatorial bloat.
      const filtered = filterWorkArticles(result.value, {
        priority: priority as PriorityType | undefined,
        assignee,
        tag,
        blocked,
      });
      const total = filtered.length;
      const page = filtered.slice(offset, offset + limit);
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

      // Tier 2.1 — optional cancellation reason + skip_guard escape hatch.
      // `reason` is required when targetPhase === "cancelled" (validated here
      // at the tool boundary; also enforced at the service boundary for
      // internal callers).
      let reason: string | undefined;
      if (args.reason !== undefined) {
        if (typeof args.reason !== "string" || args.reason.trim().length === 0) {
          return errorResponse("VALIDATION_FAILED", `"reason" must be a non-empty string`);
        }
        if (args.reason.length > 1000) {
          return errorResponse("VALIDATION_FAILED", `"reason" exceeds maximum length of 1000`);
        }
        reason = args.reason;
      }
      if (targetPhase === "cancelled" && reason === undefined) {
        return errorResponse(
          "VALIDATION_FAILED",
          `"reason" is required when targetPhase is "cancelled"`,
        );
      }

      let skipGuard: { reason: string } | undefined;
      if (args.skip_guard !== undefined) {
        if (typeof args.skip_guard !== "object" || args.skip_guard === null || Array.isArray(args.skip_guard)) {
          return errorResponse("VALIDATION_FAILED", `"skip_guard" must be an object with a "reason" field`);
        }
        const sg = args.skip_guard as Record<string, unknown>;
        const extraKeys = Object.keys(sg).filter((k) => k !== "reason");
        if (extraKeys.length > 0) {
          return errorResponse(
            "VALIDATION_FAILED",
            `"skip_guard" contains unknown keys: ${extraKeys.join(", ")}. Only "reason" is allowed.`,
          );
        }
        if (typeof sg.reason !== "string" || sg.reason.trim().length === 0) {
          return errorResponse(
            "VALIDATION_FAILED",
            `"skip_guard.reason" is required and must be a non-empty string`,
          );
        }
        if (sg.reason.length > 1000) {
          return errorResponse("VALIDATION_FAILED", `"skip_guard.reason" exceeds maximum length of 1000`);
        }
        skipGuard = { reason: sg.reason };
      }

      const options = reason !== undefined || skipGuard !== undefined
        ? { ...(reason !== undefined ? { reason } : {}), ...(skipGuard ? { skipGuard } : {}) }
        : undefined;
      const result = await service.advancePhase(id, targetPhase as WorkPhaseType, options);
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
