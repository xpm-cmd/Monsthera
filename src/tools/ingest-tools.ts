import type { IngestService } from "../ingest/service.js";
import { INGEST_MODES } from "../ingest/schemas.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import {
  errorResponse,
  isErrorResponse,
  optionalString,
  requireEnum,
  requireString,
  successResponse,
  MAX_TAGS_COUNT,
  MAX_TAG_LENGTH,
} from "./validation.js";

function optionalStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined | ToolResponse {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    return errorResponse("VALIDATION_FAILED", `"${key}" must be an array of strings`);
  }
  if (value.length > MAX_TAGS_COUNT) {
    return errorResponse("VALIDATION_FAILED", `"${key}" exceeds maximum length of ${MAX_TAGS_COUNT}`);
  }

  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return errorResponse("VALIDATION_FAILED", `"${key}" must contain only strings`);
    }
    if (item.length > MAX_TAG_LENGTH) {
      return errorResponse("VALIDATION_FAILED", `Items in "${key}" exceed maximum length of ${MAX_TAG_LENGTH}`);
    }
    items.push(item);
  }
  return items;
}

export function ingestToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "ingest_local_sources",
      description:
        "Import a local markdown/text file or directory into knowledge. Use mode=summary to normalize large source documents into concise knowledge articles.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sourcePath: { type: "string", description: "Relative or absolute path to a file or directory" },
          category: { type: "string", description: "Optional category override for imported knowledge articles" },
          tags: { type: "array", items: { type: "string" }, description: "Optional extra tags to append" },
          codeRefs: { type: "array", items: { type: "string" }, description: "Optional extra code references to append" },
          mode: {
            type: "string",
            enum: [...INGEST_MODES],
            description: "Import mode: raw preserves content, summary creates a normalized knowledge article",
          },
          recursive: { type: "boolean", description: "When sourcePath is a directory, recurse into nested folders (default true)" },
          replaceExisting: { type: "boolean", description: "Update previously imported articles with the same sourcePath (default true)" },
          noImportedTag: { type: "boolean", description: "Skip the automatic `imported` tag appended to every ingested article (default false)" },
        },
        required: ["sourcePath"],
      },
    },
  ];
}

export async function handleIngestTool(
  name: string,
  args: Record<string, unknown>,
  service: IngestService,
): Promise<ToolResponse> {
  switch (name) {
    case "ingest_local_sources": {
      const sourcePath = requireString(args, "sourcePath", 4_096);
      if (isErrorResponse(sourcePath)) return sourcePath;

      const category = optionalString(args, "category", 100);
      if (isErrorResponse(category)) return category;

      const tags = optionalStringArray(args, "tags");
      if (isErrorResponse(tags)) return tags;

      const codeRefs = optionalStringArray(args, "codeRefs");
      if (isErrorResponse(codeRefs)) return codeRefs;

      const mode = optionalString(args, "mode", 20);
      if (isErrorResponse(mode)) return mode;
      if (mode !== undefined) {
        const modeErr = requireEnum(mode, new Set(INGEST_MODES), "mode");
        if (modeErr) return modeErr;
      }

      if (args.recursive !== undefined && typeof args.recursive !== "boolean") {
        return errorResponse("VALIDATION_FAILED", "\"recursive\" must be a boolean");
      }

      if (args.replaceExisting !== undefined && typeof args.replaceExisting !== "boolean") {
        return errorResponse("VALIDATION_FAILED", "\"replaceExisting\" must be a boolean");
      }

      if (args.noImportedTag !== undefined && typeof args.noImportedTag !== "boolean") {
        return errorResponse("VALIDATION_FAILED", "\"noImportedTag\" must be a boolean");
      }

      const result = await service.importLocal({
        sourcePath,
        category,
        tags,
        codeRefs,
        mode,
        recursive: args.recursive as boolean | undefined,
        replaceExisting: args.replaceExisting as boolean | undefined,
        noImportedTag: args.noImportedTag as boolean | undefined,
      });
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
