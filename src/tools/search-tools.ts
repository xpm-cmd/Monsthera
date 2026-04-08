import type { SearchService } from "../search/service.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { successResponse, errorResponse, requireString, isErrorResponse, requireEnum } from "./validation.js";

export type { ToolDefinition, ToolResponse };

/** Returns the 4 search tool definitions for MCP ListTools */
export function searchToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "search",
      description:
        "Search across knowledge and work articles with BM25 ranking. Returns scored results with snippets. Note: articles must be explicitly indexed via index_article or reindex_all before they appear in search results.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          type: {
            type: "string",
            enum: ["knowledge", "work", "all"],
            description: "Filter by article type",
          },
          limit: { type: "number", description: "Maximum results (1-100, default 20)" },
          offset: { type: "number", description: "Skip N results (default 0)" },
        },
        required: ["query"],
      },
    },
    {
      name: "index_article",
      description: "Index or re-index a specific article for search. Call after creating or updating an article to make it searchable.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Article ID" },
          source: {
            type: "string",
            enum: ["knowledge", "work"],
            description: "Article source type",
          },
        },
        required: ["id", "source"],
      },
    },
    {
      name: "remove_from_index",
      description: "Remove an article from the search index. Call after deleting an article.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Article ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "reindex_all",
      description:
        "Rebuild the entire search index from all knowledge and work articles.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];
}

// ─── Valid source values ──────────────────────────────────────────────────────

const VALID_SOURCES = new Set(["knowledge", "work"]);

// ─── Handler ──────────────────────────────────────────────────────────────────

/** Handle a search tool call */
export async function handleSearchTool(
  name: string,
  args: Record<string, unknown>,
  service: SearchService,
): Promise<ToolResponse> {
  switch (name) {
    case "search": {
      const result = await service.search(args);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "index_article": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const source = requireString(args, "source");
      if (isErrorResponse(source)) return source;
      const sourceErr = requireEnum(source, VALID_SOURCES, "source");
      if (sourceErr) return sourceErr;
      const result =
        source === "knowledge"
          ? await service.indexKnowledgeArticle(id)
          : await service.indexWorkArticle(id);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse({ indexed: true });
    }
    case "remove_from_index": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const result = await service.removeArticle(id);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse({ removed: true });
    }
    case "reindex_all": {
      const result = await service.fullReindex();
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
