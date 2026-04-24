import type { StructureService } from "../structure/service.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { errorResponse, requireString, successResponse, isErrorResponse } from "./validation.js";

export type { ToolDefinition, ToolResponse };

/**
 * Reference-graph MCP tools. Unlike `get_article`'s connections block
 * (which is bounded at 10 via StructureService.getNeighbors), these tools
 * return the full edge set — use them when auditing, not when browsing.
 */
export function refsToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "refs_incoming",
      description:
        "List every knowledge or work article that cites `<id>`. Full set, no truncation — audit-grade. Complements `get_article.connections.referencedBy`, which is capped at 10 for browsing.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Article id or slug." },
        },
        required: ["id"],
      },
    },
    {
      name: "refs_outgoing",
      description:
        "List every knowledge or work article cited by `<id>`. Full set, no truncation.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Article id or slug." },
        },
        required: ["id"],
      },
    },
    {
      name: "refs_orphans",
      description:
        "List every citation in the corpus whose target does not resolve to an existing article. Picks up both frontmatter `references` entries and inline `k-*` / `w-*` IDs mentioned in prose. Returns the source article id plus the markdown-root-relative path so reviewers can jump directly to the file.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];
}

export async function handleRefsTool(
  name: string,
  args: Record<string, unknown>,
  structureService: StructureService,
): Promise<ToolResponse> {
  if (name === "refs_incoming" || name === "refs_outgoing") {
    const id = requireString(args, "id");
    if (isErrorResponse(id)) return id;

    const result = await structureService.getRefGraph(id);
    if (!result.ok) return errorResponse(result.error.code, result.error.message);

    const edges = name === "refs_incoming" ? result.value.incoming : result.value.outgoing;
    return successResponse({ articleId: result.value.articleId, edges });
  }

  if (name === "refs_orphans") {
    const result = await structureService.getOrphanCitations();
    if (!result.ok) return errorResponse(result.error.code, result.error.message);
    return successResponse({ orphans: result.value });
  }

  return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
}
