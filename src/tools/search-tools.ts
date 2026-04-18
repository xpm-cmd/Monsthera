import type { SearchService } from "../search/service.js";
import type { KnowledgeArticleRepository } from "../knowledge/repository.js";
import type { WorkArticleRepository } from "../work/repository.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { successResponse, errorResponse, requireString, isErrorResponse, requireEnum } from "./validation.js";

export type { ToolDefinition, ToolResponse };

/** Optional deps needed to enrich build_context_pack with full article content. */
export interface SearchToolDeps {
  readonly knowledgeRepo: Pick<KnowledgeArticleRepository, "findById">;
  readonly workRepo: Pick<WorkArticleRepository, "findById">;
}

/** Returns the search tool definitions for MCP ListTools */
export function searchToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "search",
      description:
        "Quick discovery across knowledge and work articles with BM25 keyword ranking. Queries work best with specific keywords (1-3 terms, AND semantics); longer queries use OR semantics ranked by BM25. For deep coding or investigation, prefer build_context_pack. Normal CRUD flows sync search automatically; use reindex_all only for bulk backfills or repair.",
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
      name: "build_context_pack",
      description:
        "Recommended first step before coding or investigation. Builds a ranked context pack using search plus freshness, quality, and code-link signals so agents can read less, plan faster, and then open only the top knowledge/work items. Pass `include_content: true` to inline the full body of each ranked item (skips the per-result get_article / get_work round-trip).",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query used to assemble the pack" },
          mode: {
            type: "string",
            enum: ["general", "code", "research"],
            description: "Optimize the pack for general planning, code generation, or investigation",
          },
          type: {
            type: "string",
            enum: ["knowledge", "work", "all"],
            description: "Filter by article type",
          },
          limit: { type: "number", description: "Maximum context pack items (1-20, default 8)" },
          verbose: { type: "boolean", description: "Include full diagnostics and metadata (default false)" },
          include_content: {
            type: "boolean",
            description: "Inline the full `content` of each ranked article alongside the snippet, so agents can skip follow-up get_article / get_work calls (default false — slim response is the default).",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "index_article",
      description: "Index or re-index a specific article for search. This is mainly for repair or backfill flows; normal create/update flows already sync automatically.",
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
      description: "Remove an article from the search index. This is mainly for repair flows; normal delete flows already sync automatically.",
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
        "Rebuild the entire search index from all knowledge and work articles. Use this only after migrations, bulk imports, or recovery work.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];
}

// ─── Valid source values ──────────────────────────────────────────────────────

const VALID_SOURCES = new Set(["knowledge", "work"]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the full body of every ranked pack item in parallel. Missing
 * articles (e.g. deleted after indexing) are skipped silently rather than
 * failing the whole request — the caller still gets the rank plus whatever
 * content survives.
 */
async function loadContentForPack(
  items: readonly { id: string; type: "knowledge" | "work" }[],
  deps: SearchToolDeps,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const results = await Promise.all(
    items.map(async (item) => {
      const repo = item.type === "knowledge" ? deps.knowledgeRepo : deps.workRepo;
      const res = await repo.findById(item.id);
      return res.ok ? ([item.id, res.value.content] as const) : null;
    }),
  );
  for (const entry of results) {
    if (entry !== null) out.set(entry[0], entry[1]);
  }
  return out;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/** Handle a search tool call */
export async function handleSearchTool(
  name: string,
  args: Record<string, unknown>,
  service: SearchService,
  deps?: SearchToolDeps,
): Promise<ToolResponse> {
  switch (name) {
    case "search": {
      const result = await service.search(args);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "build_context_pack": {
      if (args.include_content !== undefined && typeof args.include_content !== "boolean") {
        return errorResponse("VALIDATION_FAILED", `"include_content" must be a boolean`);
      }
      const includeContent = args.include_content === true;
      const result = await service.buildContextPack(args);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      const verbose = args.verbose === true;

      // When include_content is requested AND we have repo access, resolve
      // each item to its full body in parallel. Without deps we silently
      // fall back to the snippet-only shape — the tool stays usable in
      // test contexts or reduced wiring without surprising the caller.
      const contentById = includeContent && deps
        ? await loadContentForPack(result.value.items, deps)
        : new Map<string, string>();

      const withContent = <T extends { id: string }>(item: T): T & { content?: string } => {
        if (!includeContent) return item;
        const content = contentById.get(item.id);
        return content !== undefined ? { ...item, content } : item;
      };

      if (verbose) {
        return successResponse({
          ...result.value,
          items: result.value.items.map(withContent),
        });
      }
      // Slim response: strip diagnostics, reason, searchScore, sourcePath, references
      const slimItems = result.value.items.map((item) => withContent({
        id: item.id,
        title: item.title,
        type: item.type,
        score: item.score,
        snippet: item.snippet,
        updatedAt: item.updatedAt,
        ...(item.category !== undefined && { category: item.category }),
        ...(item.template !== undefined && { template: item.template }),
        ...(item.phase !== undefined && { phase: item.phase }),
        codeRefs: item.codeRefs,
        ...(item.staleCodeRefs.length > 0 && { staleCodeRefs: item.staleCodeRefs }),
      }));
      return successResponse({
        query: result.value.query,
        mode: result.value.mode,
        summary: result.value.summary,
        guidance: result.value.guidance,
        items: slimItems,
      });
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
