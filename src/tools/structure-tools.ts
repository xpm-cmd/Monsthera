import type { StructureService, StructureEdgeKind } from "../structure/service.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { successResponse, errorResponse, requireString, optionalNumber, isErrorResponse } from "./validation.js";

const VALID_EDGE_KINDS: ReadonlySet<string> = new Set([
  "reference",
  "dependency",
  "code_ref",
  "shared_tag",
]);

export function structureToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "get_neighbors",
      description:
        "Navigate the knowledge graph from any article. Returns direct connections (references, dependencies, shared tags, code links) so agents can explore related articles without searching. Use after search or get_article to discover connected context.",
      inputSchema: {
        type: "object" as const,
        properties: {
          article: {
            type: "string",
            description: "Article ID, slug, or node ID (e.g. k-dnd6o15p, architecture-overview)",
          },
          edge_kinds: {
            type: "array",
            items: { type: "string", enum: ["reference", "dependency", "code_ref", "shared_tag"] },
            description: "Filter by edge type (default: all types)",
          },
          limit: {
            type: "number",
            description: "Max neighbors to return (1-50, default 20)",
          },
        },
        required: ["article"],
      },
    },
    {
      name: "get_graph_summary",
      description:
        "Get a high-level overview of the knowledge graph: node/edge counts by type, and structural gaps (missing references, broken code refs). Use for orientation before navigating.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];
}

export async function handleStructureTool(
  name: string,
  args: Record<string, unknown>,
  service: StructureService,
): Promise<ToolResponse> {
  switch (name) {
    case "get_neighbors": {
      const article = requireString(args, "article", 200);
      if (isErrorResponse(article)) return article;

      const limit = optionalNumber(args, "limit", 1, 50);
      if (isErrorResponse(limit)) return limit;

      // Validate edge_kinds array if provided
      let edgeKinds: StructureEdgeKind[] | undefined;
      if (Array.isArray(args.edge_kinds)) {
        for (const kind of args.edge_kinds) {
          if (typeof kind !== "string" || !VALID_EDGE_KINDS.has(kind)) {
            return errorResponse(
              "VALIDATION_FAILED",
              `Invalid edge kind "${kind}". Must be one of: ${[...VALID_EDGE_KINDS].join(", ")}`,
            );
          }
        }
        edgeKinds = args.edge_kinds as StructureEdgeKind[];
      }

      const result = await service.getNeighbors(article, {
        edgeKinds,
        limit: limit ?? undefined,
      });
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }

    case "get_graph_summary": {
      const result = await service.getGraphSummary();
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }

    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
