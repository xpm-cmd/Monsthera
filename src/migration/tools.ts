import type { MigrationService } from "./service.js";
import type { ToolDefinition, ToolResponse } from "../tools/knowledge-tools.js";
import type { MigrationMode, MigrationScope } from "./types.js";
import { successResponse, errorResponse, requireString, isErrorResponse, requireEnum } from "../tools/validation.js";

const VALID_MODES: Set<string> = new Set(["dry-run", "validate", "execute"]);
const VALID_SCOPES: Set<string> = new Set(["work", "knowledge", "all"]);

// ─── Tool Definitions ────────────────────────────────────────────────────────

export function migrationToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "migrate_v2",
      description:
        "Run v2-to-v3 migration. Migrates tickets to v3 work articles and/or knowledge rows to v3 knowledge articles. " +
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
          scope: {
            type: "string",
            enum: ["work", "knowledge", "all"],
            description: "Migration scope: work tickets, knowledge/notes, or all (default: all)",
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
      const mode = requireString(args, "mode");
      if (isErrorResponse(mode)) return mode;
      const modeErr = requireEnum(mode, VALID_MODES, "mode");
      if (modeErr) return modeErr;
      const force = typeof args.force === "boolean" ? args.force : false;
      const scopeRaw = typeof args.scope === "string" ? args.scope : "all";
      const scopeErr = requireEnum(scopeRaw, VALID_SCOPES, "scope");
      if (scopeErr) return scopeErr;
      const result = await service.run(mode as MigrationMode, { force, scope: scopeRaw as MigrationScope });
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "migration_status": {
      const result = await service.getStatus();
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "resolve_v2_alias": {
      const alias = requireString(args, "alias");
      if (isErrorResponse(alias)) return alias;
      const result = await service.resolveAlias(alias);
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
