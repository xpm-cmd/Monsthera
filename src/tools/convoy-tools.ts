import { agentId as toAgentId, convoyId, workId, VALID_PHASES } from "../core/types.js";
import type { AgentId, ConvoyId, WorkId, WorkPhase } from "../core/types.js";
import type { ConvoyRepository } from "../orchestration/convoy-repository.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import {
  errorResponse,
  isErrorResponse,
  optionalString,
  requireString,
  successResponse,
} from "./validation.js";

const VALID_TARGET_PHASES = [...VALID_PHASES];

export interface ConvoyToolDeps {
  readonly convoyRepo: ConvoyRepository;
}

/**
 * Dispatch a single convoy_* MCP tool call. Mirrors the events-tools
 * shape: a tiny switch keeps each handler isolated. ADR-009 — convoys
 * are orchestration state, not knowledge content; the tools intentionally
 * do NOT mutate any markdown.
 */
export async function handleConvoyTool(
  name: string,
  args: Record<string, unknown>,
  deps: ConvoyToolDeps,
): Promise<ToolResponse> {
  switch (name) {
    case "convoy_create":
      return handleCreate(args, deps);
    case "convoy_list":
      return handleList(deps);
    case "convoy_get":
      return handleGet(args, deps);
    case "convoy_complete":
      return handleComplete(args, deps);
    case "convoy_cancel":
      return handleCancel(args, deps);
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}

async function handleGet(
  args: Record<string, unknown>,
  deps: ConvoyToolDeps,
): Promise<ToolResponse> {
  const id = requireString(args, "id");
  if (isErrorResponse(id)) return id;
  const result = await deps.convoyRepo.findById(convoyId(id) as ConvoyId);
  if (!result.ok) return errorResponse(result.error.code, result.error.message);
  return successResponse(result.value);
}

async function handleCreate(
  args: Record<string, unknown>,
  deps: ConvoyToolDeps,
): Promise<ToolResponse> {
  const lead = requireString(args, "leadWorkId");
  if (isErrorResponse(lead)) return lead;
  const goal = requireString(args, "goal", 1000);
  if (isErrorResponse(goal)) return goal;
  const membersRaw = args["memberWorkIds"];
  if (!Array.isArray(membersRaw) || membersRaw.length === 0) {
    return errorResponse("VALIDATION_FAILED", "`memberWorkIds` must be a non-empty array of work ids");
  }
  const members: WorkId[] = [];
  for (const m of membersRaw) {
    if (typeof m !== "string" || m.length === 0) {
      return errorResponse("VALIDATION_FAILED", "`memberWorkIds` entries must be non-empty strings");
    }
    members.push(workId(m));
  }
  const targetPhase = optionalString(args, "targetPhase");
  if (isErrorResponse(targetPhase)) return targetPhase;
  if (targetPhase && !VALID_TARGET_PHASES.includes(targetPhase as WorkPhase)) {
    return errorResponse(
      "VALIDATION_FAILED",
      `\`targetPhase\` must be one of: ${VALID_TARGET_PHASES.join(", ")}`,
    );
  }
  const actor = optionalString(args, "actor");
  if (isErrorResponse(actor)) return actor;

  const result = await deps.convoyRepo.create({
    leadWorkId: workId(lead),
    memberWorkIds: members,
    goal,
    ...(targetPhase ? { targetPhase: targetPhase as WorkPhase } : {}),
    ...(actor ? { actor: toAgentId(actor) as AgentId } : {}),
  });
  if (!result.ok) return errorResponse(result.error.code, result.error.message);
  return successResponse(result.value);
}

async function handleList(deps: ConvoyToolDeps): Promise<ToolResponse> {
  const result = await deps.convoyRepo.findActive();
  if (!result.ok) return errorResponse(result.error.code, result.error.message);
  return successResponse({ convoys: result.value });
}

async function handleComplete(
  args: Record<string, unknown>,
  deps: ConvoyToolDeps,
): Promise<ToolResponse> {
  const id = requireString(args, "id");
  if (isErrorResponse(id)) return id;
  const options = parseTerminationOptions(args);
  if (isErrorResponse(options)) return options;
  const result = await deps.convoyRepo.complete(convoyId(id) as ConvoyId, options);
  if (!result.ok) return errorResponse(result.error.code, result.error.message);
  return successResponse(result.value);
}

async function handleCancel(
  args: Record<string, unknown>,
  deps: ConvoyToolDeps,
): Promise<ToolResponse> {
  const id = requireString(args, "id");
  if (isErrorResponse(id)) return id;
  const options = parseTerminationOptions(args);
  if (isErrorResponse(options)) return options;
  const result = await deps.convoyRepo.cancel(convoyId(id) as ConvoyId, options);
  if (!result.ok) return errorResponse(result.error.code, result.error.message);
  return successResponse(result.value);
}

function parseTerminationOptions(
  args: Record<string, unknown>,
): { actor?: AgentId; terminationReason?: string } | ToolResponse {
  const actor = optionalString(args, "actor");
  if (isErrorResponse(actor)) return actor;
  const terminationReason = optionalString(args, "terminationReason", 1000);
  if (isErrorResponse(terminationReason)) return terminationReason;
  return {
    ...(actor ? { actor: toAgentId(actor) as AgentId } : {}),
    ...(terminationReason ? { terminationReason } : {}),
  };
}

/** MCP tool definitions for the convoy surface (ADR-009). */
export function convoyToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "convoy_create",
      description:
        "Create a convoy: a named group of work articles where the lead's progress past `targetPhase` unblocks members. Default targetPhase is `implementation`. Emits a `convoy_created` provenance event (envelope `workId` = lead).",
      inputSchema: {
        type: "object" as const,
        properties: {
          leadWorkId: { type: "string", description: "Work id of the convoy lead." },
          memberWorkIds: {
            type: "array",
            description: "Work ids of the convoy members. Must not include the lead. A work id already participating in another active convoy is rejected with ALREADY_EXISTS (ADR-010).",
            items: { type: "string" },
          },
          goal: { type: "string", description: "Free-text rationale for the grouping." },
          targetPhase: {
            type: "string",
            description: "Phase the lead must reach before members are eligible. Default: implementation.",
            enum: VALID_TARGET_PHASES,
          },
          actor: {
            type: "string",
            description: "Optional agent id forming the convoy. Captured in the convoy_created event for provenance.",
          },
        },
        required: ["leadWorkId", "memberWorkIds", "goal"],
      },
    },
    {
      name: "convoy_list",
      description: "List active convoys. Terminal (completed/cancelled) convoys are not returned.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "convoy_get",
      description: "Get a single convoy by id (active OR terminal). Returns NOT_FOUND if no convoy with that id exists.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Convoy id." },
        },
        required: ["id"],
      },
    },
    {
      name: "convoy_complete",
      description: "Mark an active convoy as completed. Re-completion of a terminal convoy is rejected. Emits a `convoy_completed` provenance event.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Convoy id." },
          actor: { type: "string", description: "Optional agent id completing the convoy. Captured in the event." },
          terminationReason: { type: "string", description: "Optional free-text reason. Captured in the event." },
        },
        required: ["id"],
      },
    },
    {
      name: "convoy_cancel",
      description: "Mark an active convoy as cancelled. Re-cancellation of a terminal convoy is rejected. Emits a `convoy_cancelled` provenance event.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Convoy id." },
          actor: { type: "string", description: "Optional agent id cancelling the convoy. Captured in the event." },
          terminationReason: { type: "string", description: "Optional free-text reason. Captured in the event." },
        },
        required: ["id"],
      },
    },
  ];
}
