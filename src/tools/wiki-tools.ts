import type { WikiBookkeeper } from "../knowledge/wiki-bookkeeper.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { successResponse, errorResponse, optionalNumber, isErrorResponse } from "./validation.js";

export type { ToolDefinition, ToolResponse };

const MAX_TAIL = 10_000;

/** Returns the wiki tool definitions for MCP ListTools. */
export function wikiToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "get_wiki_index",
      description:
        "Read `knowledge/index.md` — the auto-maintained catalog of ALL knowledge articles (grouped by category) and work articles (grouped by phase), with relative links and short snippets. Best first move for a broad overview of what exists before picking a search query. The file is rebuilt on every create/update/delete and at startup; read once per task rather than per loop.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "get_wiki_log",
      description:
        "Read `knowledge/log.md` — the append-only mutation log. Every create/update/delete/advance/reindex/rename records a timestamped line. Use to understand recent activity, reconstruct change order, or answer \"what changed recently?\" without scanning git history. Pass `tail` to cap the response at the last N entries (header lines are always preserved).",
      inputSchema: {
        type: "object" as const,
        properties: {
          tail: {
            type: "number",
            description: `Return only the last N entry lines (1-${MAX_TAIL}). Omit to return the full log.`,
          },
        },
      },
    },
  ];
}

/** Handle a wiki tool call. */
export async function handleWikiTool(
  name: string,
  args: Record<string, unknown>,
  bookkeeper: WikiBookkeeper,
): Promise<ToolResponse> {
  switch (name) {
    case "get_wiki_index": {
      const result = await bookkeeper.readIndex();
      if (result === null) {
        return errorResponse(
          "NOT_FOUND",
          "index.md has not been written yet — create a knowledge or work article to initialize it",
        );
      }
      return successResponse({ content: result.content, path: result.path });
    }
    case "get_wiki_log": {
      const tailArg = optionalNumber(args, "tail", 1, MAX_TAIL);
      if (isErrorResponse(tailArg)) return tailArg;
      const result = await bookkeeper.readLog(tailArg !== undefined ? { tail: tailArg } : undefined);
      if (result === null) {
        return errorResponse(
          "NOT_FOUND",
          "log.md has not been written yet — mutate a knowledge or work article to initialize it",
        );
      }
      return successResponse({
        content: result.content,
        path: result.path,
        totalLines: result.totalLines,
      });
    }
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
