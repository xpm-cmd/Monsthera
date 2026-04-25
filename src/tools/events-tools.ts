import type { WorkArticleRepository } from "../work/repository.js";
import { workId, agentId } from "../core/types.js";
import {
  AGENT_LIFECYCLE_EVENT_TYPES,
  VALID_ORCHESTRATION_EVENT_TYPES,
  type AgentLifecycleEventType,
  type OrchestrationEvent,
  type OrchestrationEventRepository,
  type OrchestrationEventType,
} from "../orchestration/repository.js";
import type { AgentLifecycleDetails } from "../orchestration/types.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import {
  errorResponse,
  isErrorResponse,
  optionalNumber,
  optionalString,
  requireString,
  successResponse,
} from "./validation.js";

/** Same restriction as the CLI — `agent_needed` is dispatcher-only. */
const HARNESS_EMIT_TYPES: ReadonlySet<string> = new Set<string>([
  "agent_started",
  "agent_completed",
  "agent_failed",
]);

const VALID_TYPE_LABELS = [...VALID_ORCHESTRATION_EVENT_TYPES];
// Reference the constant to keep the import alive — the validation set is
// what we actually consult, but exporting via labels keeps tool schemas honest.
void AGENT_LIFECYCLE_EVENT_TYPES;

export interface EventsToolDeps {
  readonly eventRepo: OrchestrationEventRepository;
  readonly workRepo: WorkArticleRepository;
}

/**
 * Dispatch a single events_* MCP tool call. Mirrors the CLI semantics:
 * `events_subscribe` is read-only and accepts any event type filter;
 * `events_emit` is restricted to harness-side lifecycle states because
 * `agent_needed` is owned by the dispatcher.
 */
export async function handleEventsTool(
  name: string,
  args: Record<string, unknown>,
  deps: EventsToolDeps,
): Promise<ToolResponse> {
  switch (name) {
    case "events_subscribe":
      return handleSubscribe(args, deps.eventRepo);
    case "events_emit":
      return handleEmit(args, deps);
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}

async function handleSubscribe(
  args: Record<string, unknown>,
  repo: OrchestrationEventRepository,
): Promise<ToolResponse> {
  const typeArg = optionalString(args, "type");
  if (isErrorResponse(typeArg)) return typeArg;
  if (typeArg && !VALID_ORCHESTRATION_EVENT_TYPES.has(typeArg as OrchestrationEventType)) {
    return errorResponse(
      "VALIDATION_FAILED",
      `Invalid type "${typeArg}". Must be one of: ${VALID_TYPE_LABELS.join(", ")}`,
    );
  }
  const widArg = optionalString(args, "workId");
  if (isErrorResponse(widArg)) return widArg;
  const sinceArg = optionalString(args, "since");
  if (isErrorResponse(sinceArg)) return sinceArg;
  const limitVal = optionalNumber(args, "limit", 1, 1000);
  if (isErrorResponse(limitVal)) return limitVal;
  const limit = limitVal ?? 50;

  let events: readonly OrchestrationEvent[];
  if (widArg) {
    const result = await repo.findByWorkId(workId(widArg));
    if (!result.ok) return errorResponse(result.error.code, result.error.message);
    events = filterAndSlice(result.value, typeArg as OrchestrationEventType | undefined, sinceArg, limit);
  } else if (typeArg) {
    const result = await repo.findByType(typeArg as OrchestrationEventType);
    if (!result.ok) return errorResponse(result.error.code, result.error.message);
    events = filterAndSlice(result.value, undefined, sinceArg, limit);
  } else {
    const result = await repo.findRecent(limit);
    if (!result.ok) return errorResponse(result.error.code, result.error.message);
    events = filterAndSlice(result.value, undefined, sinceArg, limit);
  }

  // Cursor: most recent event id by createdAt. Callers pass it back as
  // `since`. Empty string when no events match — the harness keeps polling
  // with no cursor until something appears.
  const cursor = events.length > 0
    ? events.reduce((acc, e) => (e.createdAt > acc.createdAt ? e : acc)).id
    : "";

  return successResponse({ events, cursor });
}

function filterAndSlice(
  events: readonly OrchestrationEvent[],
  type: OrchestrationEventType | undefined,
  since: string | undefined,
  limit: number,
): readonly OrchestrationEvent[] {
  let filtered = type ? events.filter((e) => e.eventType === type) : events;
  if (since) {
    // Locate the cursor and keep events strictly after it. Falls back to
    // returning everything if the cursor id is unknown — better to over-
    // emit once than to silently drop the harness's place in the stream.
    const cursorEvent = filtered.find((e) => e.id === since);
    if (cursorEvent) {
      filtered = filtered.filter((e) => e.createdAt > cursorEvent.createdAt);
    }
  }
  // Sort newest-first for transport consistency, then slice. The CLI
  // reverses these for tail-style display; the MCP caller can do the same.
  const sorted = [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return sorted.slice(0, limit);
}

async function handleEmit(
  args: Record<string, unknown>,
  deps: EventsToolDeps,
): Promise<ToolResponse> {
  const type = requireString(args, "type");
  if (isErrorResponse(type)) return type;
  if (!HARNESS_EMIT_TYPES.has(type)) {
    return errorResponse(
      "VALIDATION_FAILED",
      `Invalid type "${type}". events_emit accepts only: agent_started, agent_completed, agent_failed. agent_needed is dispatcher-only.`,
    );
  }
  const wid = requireString(args, "workId");
  if (isErrorResponse(wid)) return wid;
  const role = requireString(args, "role");
  if (isErrorResponse(role)) return role;
  const from = requireString(args, "from");
  if (isErrorResponse(from)) return from;
  const to = requireString(args, "to");
  if (isErrorResponse(to)) return to;
  const aid = optionalString(args, "agentId");
  if (isErrorResponse(aid)) return aid;
  const errMsg = optionalString(args, "error", 1000);
  if (isErrorResponse(errMsg)) return errMsg;

  if (type === "agent_failed" && !errMsg) {
    return errorResponse("VALIDATION_FAILED", "`error` is required when type=agent_failed");
  }

  const articleResult = await deps.workRepo.findById(wid);
  if (!articleResult.ok) {
    return errorResponse(articleResult.error.code, `Unknown work article "${wid}"`);
  }

  const details: AgentLifecycleDetails = {
    role,
    transition: { from: from as never, to: to as never },
    ...(errMsg ? { error: errMsg } : {}),
  };

  const result = await deps.eventRepo.logEvent({
    workId: workId(wid),
    eventType: type as AgentLifecycleEventType,
    ...(aid ? { agentId: agentId(aid) } : {}),
    details: details as unknown as Record<string, unknown>,
  });
  if (!result.ok) return errorResponse(result.error.code, result.error.message);
  return successResponse(result.value);
}

/** MCP tool definitions for the agent-dispatch event surface. */
export function eventsToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "events_subscribe",
      description:
        "Read recent orchestration events with optional filters. Returns a snapshot plus a `cursor` (the most recent event id seen); call again with `since=<cursor>` to poll for new events. MCP has no native push, so this is poll-with-cursor rather than a true subscription.",
      inputSchema: {
        type: "object" as const,
        properties: {
          type: {
            type: "string",
            description: "Filter by event type.",
            enum: VALID_TYPE_LABELS,
          },
          workId: { type: "string", description: "Filter by work article id." },
          since: {
            type: "string",
            description: "Cursor returned by a prior call. Returns events strictly newer than this id, by createdAt.",
          },
          limit: { type: "number", description: "Max events to return (default 50, max 1000)." },
        },
      },
    },
    {
      name: "events_emit",
      description:
        "Emit one agent-lifecycle event. Accepts only `agent_started`, `agent_completed`, or `agent_failed` — `agent_needed` is dispatcher-only. The work article must exist; required fields are validated strictly.",
      inputSchema: {
        type: "object" as const,
        properties: {
          type: {
            type: "string",
            description: "Lifecycle event type.",
            enum: ["agent_started", "agent_completed", "agent_failed"],
          },
          workId: { type: "string", description: "Work article id." },
          role: { type: "string", description: "Agent role being reported on." },
          from: { type: "string", description: "Phase the agent was helping advance from." },
          to: { type: "string", description: "Phase the agent was helping advance to." },
          agentId: { type: "string", description: "Optional agent identifier." },
          error: { type: "string", description: "Required when type=agent_failed." },
        },
        required: ["type", "workId", "role", "from", "to"],
      },
    },
  ];
}
