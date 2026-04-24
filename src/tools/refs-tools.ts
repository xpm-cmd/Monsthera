import type { StructureService, CitationValueFinding } from "../structure/service.js";
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
    {
      name: "verify_citations",
      description:
        "Verify inline citation-with-number pairs against the cited article's content. For every `(citation, adjacent-number)` pair in source prose, resolve the citation to a knowledge or work article and check whether the claimed number appears in that article's text. Mismatches surface as `{ sourceArticle, citedArticle, claimedValue, foundValues, lineHint }`. Orphan (unknown-target) citations are NOT reported here — use `refs_orphans` for that. Pass `articleId` to check a single article, or `all: true` to iterate every article in the corpus (O(N*M) in citation pairs — use with intent).",
      inputSchema: {
        type: "object" as const,
        properties: {
          articleId: {
            type: "string",
            description: "Article id or slug. Mutually exclusive with `all`.",
          },
          all: {
            type: "boolean",
            description: "Iterate every knowledge + work article. Default false.",
          },
        },
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

  if (name === "verify_citations") {
    const all = args.all === true;
    const articleId = typeof args.articleId === "string" ? args.articleId : undefined;

    if (all && articleId) {
      return errorResponse(
        "VALIDATION_FAILED",
        "Pass either `articleId` or `all: true`, not both.",
      );
    }
    if (!all && !articleId) {
      return errorResponse("VALIDATION_FAILED", "Provide `articleId` or set `all: true`.");
    }

    if (articleId) {
      const res = await structureService.verifyCitedValues(articleId);
      if (!res.ok) return errorResponse(res.error.code, res.error.message);
      return successResponse({ findings: res.value });
    }

    // `all`: enumerate via the already-computed graph — avoids widening
    // this handler's deps to include the raw repos.
    const graph = await structureService.getGraph();
    if (!graph.ok) return errorResponse(graph.error.code, graph.error.message);

    const findings: CitationValueFinding[] = [];
    for (const node of graph.value.nodes) {
      if (node.kind !== "knowledge" && node.kind !== "work") continue;
      if (!node.articleId) continue;
      const res = await structureService.verifyCitedValues(node.articleId);
      if (!res.ok) continue;
      findings.push(...res.value);
    }
    return successResponse({ findings });
  }

  return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
}
