import type { SnapshotService } from "../context/snapshot-service.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import {
  successResponse,
  errorResponse,
  requireString,
  optionalString,
  isErrorResponse,
  MAX_CONTENT_LENGTH,
} from "./validation.js";

export type { ToolDefinition, ToolResponse };

/** Returns MCP definitions for the environment-snapshot tool family. */
export function snapshotToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "record_environment_snapshot",
      description:
        "Record a sandbox environment snapshot (cwd, file listing, runtimes, package managers, lockfile hashes, memory, git ref). Monsthera never runs shell commands itself — the caller gathers this data from its own harness (or the `scripts/capture-env-snapshot.ts` helper) and passes the parsed JSON here. Pair with `build_context_pack` so semantic context (what the project means) arrives alongside physical context (what this sandbox actually is).",
      inputSchema: {
        type: "object" as const,
        properties: {
          agentId: { type: "string", description: "Agent that captured the snapshot" },
          workId: { type: "string", description: "Optional work article the snapshot belongs to" },
          cwd: { type: "string", description: "Working directory at capture time" },
          gitRef: {
            type: "object",
            description: "Current git state at capture time",
            properties: {
              branch: { type: "string" },
              sha: { type: "string" },
              dirty: { type: "boolean" },
            },
          },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Top-level file listing",
          },
          runtimes: {
            type: "object",
            description: "Map of runtime name to version (e.g. { node: \"20.11.0\" })",
            additionalProperties: { type: "string" },
          },
          packageManagers: {
            type: "array",
            items: { type: "string" },
            description: "Package managers detected in the sandbox",
          },
          lockfiles: {
            type: "array",
            description: "Lockfile paths and their sha256 for drift detection",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                sha256: { type: "string" },
              },
              required: ["path", "sha256"],
            },
          },
          memory: {
            type: "object",
            properties: {
              totalMb: { type: "number" },
              availableMb: { type: "number" },
            },
          },
          raw: { type: "string", description: "Optional raw probe output for audit" },
        },
        required: ["agentId", "cwd"],
      },
    },
    {
      name: "get_latest_environment_snapshot",
      description:
        "Return the most recent environment snapshot for a given agent, work article, or both (workId is preferred when both are provided; falls back to the agent's latest if none was recorded against the work). Response includes `ageSeconds` and a `stale` flag based on the configured max age (MONSTHERA_SNAPSHOT_MAX_AGE_MINUTES, default 30).",
      inputSchema: {
        type: "object" as const,
        properties: {
          agentId: { type: "string" },
          workId: { type: "string" },
        },
      },
    },
    {
      name: "compare_environment_snapshots",
      description:
        "Diff two snapshots by id. Reports which runtimes, lockfile hashes, git fields, package managers, or cwd changed, plus the wall-clock age delta. Use this when resuming a work article in a new sandbox to detect drift before trusting prior state.",
      inputSchema: {
        type: "object" as const,
        properties: {
          leftId: { type: "string", description: "Older snapshot id" },
          rightId: { type: "string", description: "Newer snapshot id" },
        },
        required: ["leftId", "rightId"],
      },
    },
  ];
}

/** Dispatch a snapshot tool call. */
export async function handleSnapshotTool(
  name: string,
  args: Record<string, unknown>,
  service: SnapshotService,
): Promise<ToolResponse> {
  switch (name) {
    case "record_environment_snapshot": {
      // Boundary-level sanity check on `raw` — everything else is validated by Zod.
      if (args.raw !== undefined) {
        if (typeof args.raw !== "string") {
          return errorResponse("VALIDATION_FAILED", `"raw" must be a string`);
        }
        if (args.raw.length > MAX_CONTENT_LENGTH) {
          return errorResponse(
            "VALIDATION_FAILED",
            `"raw" exceeds maximum length of ${MAX_CONTENT_LENGTH}`,
          );
        }
      }
      const result = await service.record(args);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse({
        id: result.value.id,
        capturedAt: result.value.capturedAt,
        agentId: result.value.agentId,
        workId: result.value.workId,
      });
    }

    case "get_latest_environment_snapshot": {
      const agentId = optionalString(args, "agentId");
      if (isErrorResponse(agentId)) return agentId;
      const workId = optionalString(args, "workId");
      if (isErrorResponse(workId)) return workId;
      if (!agentId && !workId) {
        return errorResponse(
          "VALIDATION_FAILED",
          `Provide at least one of "agentId" or "workId"`,
        );
      }
      const result = await service.getLatest({ agentId, workId });
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      if (!result.value) return successResponse({ snapshot: null });
      return successResponse({
        snapshot: result.value.snapshot,
        ageSeconds: result.value.ageSeconds,
        stale: result.value.stale,
        maxAgeMinutes: service.maxAgeMinutes,
      });
    }

    case "compare_environment_snapshots": {
      const leftId = requireString(args, "leftId");
      if (isErrorResponse(leftId)) return leftId;
      const rightId = requireString(args, "rightId");
      if (isErrorResponse(rightId)) return rightId;
      const result = await service.compare(leftId, rightId);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }

    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
