import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import { fullIndex, incrementalIndex, getIndexedCommit } from "../indexing/indexer.js";
import { checkToolAccess } from "../trust/tiers.js";
import { resolveAgent } from "./resolve-agent.js";

type GetContext = () => Promise<AgoraContext>;

export function registerIndexTools(server: McpServer, getContext: GetContext): void {
  server.tool(
    "request_reindex",
    "Trigger full or incremental re-index of the repository",
    {
      full: z.boolean().default(false).describe("Force full reindex"),
      agentId: z.string().describe("Agent ID"),
      sessionId: z.string().describe("Active session ID"),
    },
    async ({ full, agentId, sessionId }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved) {
        return {
          content: [{ type: "text" as const, text: "Agent or session not found / inactive" }],
          isError: true,
        };
      }

      const access = checkToolAccess("request_reindex", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ denied: true, reason: access.reason }),
          }],
          isError: true,
        };
      }

      const indexedCommit = getIndexedCommit(c.db, c.repoId);

      c.insight.info("Reindex requested...");

      let result;
      if (!indexedCommit || full) {
        result = await fullIndex({
          repoPath: c.repoPath,
          repoId: c.repoId,
          db: c.db,
          sensitiveFilePatterns: c.config.sensitiveFilePatterns,
          excludePatterns: c.config.excludePatterns,
          onProgress: (msg) => c.insight.detail(msg),
          semanticReranker: c.searchRouter.getSemanticReranker(),
        });
      } else {
        result = await incrementalIndex(indexedCommit, {
          repoPath: c.repoPath,
          repoId: c.repoId,
          db: c.db,
          sensitiveFilePatterns: c.config.sensitiveFilePatterns,
          excludePatterns: c.config.excludePatterns,
          onProgress: (msg) => c.insight.detail(msg),
          semanticReranker: c.searchRouter.getSemanticReranker(),
        });
      }

      await c.searchRouter.rebuildIndex(c.repoId);
      c.insight.info(`Reindex complete: ${result.filesIndexed} files in ${result.durationMs}ms`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            commit: result.commit,
            filesIndexed: result.filesIndexed,
            filesSkipped: result.filesSkipped,
            errors: result.errors,
            durationMs: result.durationMs,
          }, null, 2),
        }],
      };
    },
  );
}
