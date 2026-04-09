import type { KnowledgeService } from "../knowledge/service.js";
import { successResponse, errorResponse, requireString, optionalString, isErrorResponse, MAX_QUERY_LENGTH } from "./validation.js";

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
      description: "Create a reusable knowledge article when a decision, guide, imported source, or implementation pattern should remain available for later agents. Search sync happens automatically; use reindex_all only after bulk imports or recovery work.",
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
      description: "Open a specific knowledge article by ID or slug after search, context-pack selection, or work references point to it.",
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
      description: "Update an existing knowledge article as understanding improves. Add durable wording, code refs, and reusable conclusions instead of leaving them only in chat or work history. Search sync happens automatically; manual reindex is not needed for normal edits.",
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
      description: "Delete a knowledge article by ID. Search sync happens automatically; manual remove_from_index is only for repair flows.",
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
      description: "List knowledge articles, optionally filtered by category. Best when you want to browse a domain rather than run full-text discovery.",
      inputSchema: {
        type: "object" as const,
        properties: {
          category: { type: "string", description: "Filter by category" },
        },
      },
    },
    {
      name: "search_articles",
      description: "Search knowledge articles by query string. Use this for a knowledge-only lookup; use search or build_context_pack when the task may span both work and knowledge.",
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
      const query = requireString(args, "query", MAX_QUERY_LENGTH);
      if (isErrorResponse(query)) return query;
      const result = await service.searchArticles(query);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
