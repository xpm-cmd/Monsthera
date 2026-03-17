import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import { AgentIdSchema, SessionIdSchema } from "../core/input-hardening.js";
import { fullIndex, incrementalIndex, getIndexedCommit, buildIndexOptions } from "../indexing/indexer.js";
import { checkToolAccess } from "../trust/tiers.js";
import { resolveAgent } from "./resolve-agent.js";
import { compileSecretPatterns } from "../trust/secret-patterns.js";
import { recordDashboardEvent } from "../core/events.js";

type GetContext = () => Promise<AgoraContext>;

export function registerIndexTools(server: McpServer, getContext: GetContext): void {
  server.tool(
    "request_reindex",
    "Trigger full or incremental re-index of the repository",
    {
      full: z.boolean().default(false).describe("Force full reindex"),
      agentId: AgentIdSchema.describe("Agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ full, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

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

      const indexOpts = buildIndexOptions({
        repoPath: c.repoPath,
        repoId: c.repoId,
        db: c.db,
        sensitiveFilePatterns: c.config.sensitiveFilePatterns,
        secretPatterns: compileSecretPatterns(c.config.secretPatterns),
        excludePatterns: c.config.excludePatterns,
        onProgress: (msg) => c.insight.detail(msg),
        semanticReranker: c.searchRouter.getSemanticReranker(),
      });

      let indexResult;
      if (!indexedCommit || full) {
        indexResult = await fullIndex(indexOpts);
      } else {
        indexResult = await incrementalIndex(indexedCommit, indexOpts);
      }

      await c.searchRouter.rebuildIndex(c.repoId);
      c.insight.info(`Reindex complete: ${indexResult.filesIndexed} files in ${indexResult.durationMs}ms`);
      recordDashboardEvent(c.db, c.repoId, {
        type: "index_updated",
        data: {
          commit: indexResult.commit,
          filesIndexed: indexResult.filesIndexed,
          durationMs: indexResult.durationMs,
          full: !indexedCommit || full,
          agentId: resolved.agentId,
        },
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            commit: indexResult.commit,
            filesIndexed: indexResult.filesIndexed,
            filesSkipped: indexResult.filesSkipped,
            errors: indexResult.errors,
            durationMs: indexResult.durationMs,
          }, null, 2),
        }],
      };
    },
  );
}
