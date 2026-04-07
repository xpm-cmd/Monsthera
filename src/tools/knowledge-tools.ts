import type { KnowledgeService } from "../knowledge/service.js";

/** MCP tool definition shape */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** MCP tool response shape (compatible with MCP SDK CallToolResult) */
export interface ToolResponse {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Returns the 6 knowledge tool definitions for MCP ListTools */
export function knowledgeToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "create_article",
      description: "Create a new knowledge article. Call index_article afterwards to make it searchable.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Article title" },
          category: { type: "string", description: "Article category" },
          content: { type: "string", description: "Article content (markdown)" },
          tags: { type: "array", items: { type: "string" }, description: "Tags" },
          codeRefs: { type: "array", items: { type: "string" }, description: "Code references" },
        },
        required: ["title", "category", "content"],
      },
    },
    {
      name: "get_article",
      description: "Get a knowledge article by ID or slug.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Article ID" },
          slug: { type: "string", description: "Article slug" },
        },
      },
    },
    {
      name: "update_article",
      description: "Update an existing knowledge article. Call index_article afterwards to refresh search index.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Article ID (required)" },
          title: { type: "string", description: "New title" },
          category: { type: "string", description: "New category" },
          content: { type: "string", description: "New content" },
          tags: { type: "array", items: { type: "string" }, description: "New tags" },
          codeRefs: { type: "array", items: { type: "string" }, description: "New code refs" },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_article",
      description: "Delete a knowledge article by ID. Call remove_from_index afterwards to clean search index.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Article ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_articles",
      description: "List knowledge articles, optionally filtered by category.",
      inputSchema: {
        type: "object" as const,
        properties: {
          category: { type: "string", description: "Filter by category" },
        },
      },
    },
    {
      name: "search_articles",
      description: "Search knowledge articles by query string.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  ];
}

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

/** Handle a knowledge tool call */
export async function handleKnowledgeTool(
  name: string,
  args: Record<string, unknown>,
  service: KnowledgeService,
): Promise<ToolResponse> {
  switch (name) {
    case "create_article": {
      // args passed directly to service — Zod validates inside service.createArticle
      const result = await service.createArticle(args);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "get_article": {
      const id = optionalString(args, "id");
      if (isErrorResponse(id)) return id;
      const slug = optionalString(args, "slug");
      if (isErrorResponse(slug)) return slug;
      if (!id && !slug) {
        return errorResponse("VALIDATION_FAILED", "Either id or slug is required");
      }
      const result = id
        ? await service.getArticle(id)
        : await service.getArticleBySlug(slug!);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "update_article": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      // Remaining fields passed to service — Zod validates inside service.updateArticle
      const { id: _id, ...updateFields } = args;
      const result = await service.updateArticle(id, updateFields);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "delete_article": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const result = await service.deleteArticle(id);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse({ deleted: true });
    }
    case "list_articles": {
      const category = optionalString(args, "category");
      if (isErrorResponse(category)) return category;
      const result = await service.listArticles(category);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "search_articles": {
      const query = requireString(args, "query");
      if (isErrorResponse(query)) return query;
      const result = await service.searchArticles(query);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
