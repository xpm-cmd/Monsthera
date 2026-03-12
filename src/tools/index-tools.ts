import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import { AgentIdSchema, SessionIdSchema } from "../core/input-hardening.js";
import { fullIndex, incrementalIndex, getIndexedCommit } from "../indexing/indexer.js";
import { checkToolAccess } from "../trust/tiers.js";
import { resolveAgent } from "./resolve-agent.js";
import { compileSecretPatterns } from "../trust/secret-patterns.js";

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

      let indexResult;
      if (!indexedCommit || full) {
        indexResult = await fullIndex({
          repoPath: c.repoPath,
          repoId: c.repoId,
          db: c.db,
          sensitiveFilePatterns: c.config.sensitiveFilePatterns,
          secretPatterns: compileSecretPatterns(c.config.secretPatterns),
          excludePatterns: c.config.excludePatterns,
          onProgress: (msg) => c.insight.detail(msg),
          semanticReranker: c.searchRouter.getSemanticReranker(),
        });
      } else {
        indexResult = await incrementalIndex(indexedCommit, {
          repoPath: c.repoPath,
          repoId: c.repoId,
          db: c.db,
          sensitiveFilePatterns: c.config.sensitiveFilePatterns,
          secretPatterns: compileSecretPatterns(c.config.secretPatterns),
          excludePatterns: c.config.excludePatterns,
          onProgress: (msg) => c.insight.detail(msg),
          semanticReranker: c.searchRouter.getSemanticReranker(),
        });
      }

      await c.searchRouter.rebuildIndex(c.repoId);
      c.insight.info(`Reindex complete: ${indexResult.filesIndexed} files in ${indexResult.durationMs}ms`);

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
