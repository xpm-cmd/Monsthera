import type { MigrationService } from "./service.js";
import type { ToolDefinition, ToolResponse } from "../tools/knowledge-tools.js";
import type { MigrationMode } from "./types.js";

// ─── Private Helpers ─────────────────────────────────────────────────────────

function successResponse(data: unknown): ToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResponse(code: string, message: string): ToolResponse {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: code, message }) }],
    isError: true,
  };
}

const VALID_MODES: Set<string> = new Set(["dry-run", "validate", "execute"]);

// ─── Tool Definitions ────────────────────────────────────────────────────────

export function migrationToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "migrate_v2",
      description:
        "Run v2-to-v3 migration. Maps v2 tickets to v3 work articles. " +
        "Use dry-run mode first to preview changes without writing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          mode: {
            type: "string",
            enum: ["dry-run", "validate", "execute"],
            description: "Migration mode: dry-run (preview), validate (check mappings), execute (write)",
          },
          force: {
            type: "boolean",
            description: "Re-migrate tickets that were already migrated (default: false)",
          },
        },
        required: ["mode"],
      },
    },
    {
      name: "migration_status",
      description: "Show current migration status: how many v2 tickets have been migrated, aliases registered.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "resolve_v2_alias",
      description: "Resolve a v2 ticket ID to its v3 work article ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          alias: { type: "string", description: "The v2 ticket ID (e.g., T-1234)" },
        },
        required: ["alias"],
      },
    },
  ];
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleMigrationTool(
  name: string,
  args: Record<string, unknown>,
  service: MigrationService,
): Promise<ToolResponse> {
  switch (name) {
    case "migrate_v2": {
      const mode = args.mode;
      if (typeof mode !== "string" || !VALID_MODES.has(mode)) {
        return errorResponse("VALIDATION_FAILED", `"mode" must be one of: dry-run, validate, execute`);
      }
      const force = typeof args.force === "boolean" ? args.force : false;
      const result = await service.run(mode as MigrationMode, { force });
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "migration_status": {
      return successResponse({
        aliasesRegistered: service.aliasStore.size,
      });
    }
    case "resolve_v2_alias": {
      const alias = args.alias;
      if (typeof alias !== "string" || alias.length === 0) {
        return errorResponse("VALIDATION_FAILED", `"alias" is required and must be a non-empty string`);
      }
      const result = service.aliasStore.resolve(alias);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      if (result.value === undefined) {
        return errorResponse("NOT_FOUND", `No v3 article found for v2 alias: ${alias}`);
      }
      return successResponse({ v2Alias: alias, v3Id: result.value });
    }
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
