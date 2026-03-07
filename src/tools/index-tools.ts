import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import { fullIndex, incrementalIndex, getIndexedCommit } from "../indexing/indexer.js";

type GetContext = () => Promise<AgoraContext>;

export function registerIndexTools(server: McpServer, getContext: GetContext): void {
  server.tool(
    "request_reindex",
    "Trigger full or incremental re-index of the repository",
    {
      full: z.boolean().default(false).describe("Force full reindex"),
    },
    async ({ full }) => {
      const c = await getContext();
      const indexedCommit = getIndexedCommit(c.db, c.repoId);

      c.insight.info("Reindex requested...");

      let result;
      if (!indexedCommit || full) {
        result = await fullIndex({
          repoPath: c.repoPath,
          repoId: c.repoId,
          db: c.db,
          sensitiveFilePatterns: c.config.sensitiveFilePatterns,
          onProgress: (msg) => c.insight.detail(msg),
        });
      } else {
        result = await incrementalIndex(indexedCommit, {
          repoPath: c.repoPath,
          repoId: c.repoId,
          db: c.db,
          sensitiveFilePatterns: c.config.sensitiveFilePatterns,
          onProgress: (msg) => c.insight.detail(msg),
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
