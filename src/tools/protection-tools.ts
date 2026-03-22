import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import { AgentIdSchema, SessionIdSchema } from "../core/input-hardening.js";
import { checkToolAccess } from "../trust/tiers.js";
import * as queries from "../db/queries.js";
import { resolveAgent } from "./resolve-agent.js";

type GetContext = () => Promise<AgoraContext>;

export function registerProtectionTools(server: McpServer, getContext: GetContext): void {
  // ─── add_protected_artifact ──────────────────────────────────
  server.tool(
    "add_protected_artifact",
    "Add a path or glob pattern to the protected artifacts list. Patches touching protected paths are rejected.",
    {
      pathPattern: z.string().min(1).max(500).describe("File path or glob pattern to protect (e.g. '.agora/config.json' or 'src/db/schema.ts')"),
      reason: z.string().min(1).max(500).describe("Why this path is protected"),
      agentId: AgentIdSchema.describe("Agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ pathPattern, reason, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

      const access = checkToolAccess("add_protected_artifact", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ denied: true, reason: access.reason }),
          }],
          isError: true,
        };
      }

      const existing = queries.getProtectedArtifactByPattern(c.db, c.repoId, pathPattern);
      if (existing) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: "already_exists", pathPattern, existingReason: existing.reason }),
          }],
          isError: true,
        };
      }

      const artifact = queries.insertProtectedArtifact(c.db, {
        repoId: c.repoId,
        pathPattern,
        reason,
        createdBy: agentId,
        createdAt: new Date().toISOString(),
      });

      c.insight.info(`Protected artifact added: ${pathPattern} by ${agentId}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ added: true, id: artifact.id, pathPattern, reason }),
        }],
      };
    },
  );

  // ─── remove_protected_artifact ───────────────────────────────
  server.tool(
    "remove_protected_artifact",
    "Remove a path pattern from the protected artifacts list (admin only)",
    {
      pathPattern: z.string().min(1).max(500).describe("Path pattern to unprotect"),
      agentId: AgentIdSchema.describe("Agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ pathPattern, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

      const access = checkToolAccess("remove_protected_artifact", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ denied: true, reason: access.reason }),
          }],
          isError: true,
        };
      }

      const existing = queries.getProtectedArtifactByPattern(c.db, c.repoId, pathPattern);
      if (!existing) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: "not_found", pathPattern }),
          }],
          isError: true,
        };
      }

      queries.deleteProtectedArtifact(c.db, c.repoId, pathPattern);

      c.insight.info(`Protected artifact removed: ${pathPattern} by ${agentId}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ removed: true, pathPattern }),
        }],
      };
    },
  );

  // ─── list_protected_artifacts ────────────────────────────────
  server.tool(
    "list_protected_artifacts",
    "List all protected artifact rules for this repository",
    {
      agentId: AgentIdSchema.describe("Agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

      const access = checkToolAccess("list_protected_artifacts", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ denied: true, reason: access.reason }),
          }],
          isError: true,
        };
      }

      const artifacts = queries.getProtectedArtifacts(c.db, c.repoId);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: artifacts.length,
            artifacts: artifacts.map((a) => ({
              pathPattern: a.pathPattern,
              reason: a.reason,
              createdBy: a.createdBy,
              createdAt: a.createdAt,
            })),
          }),
        }],
      };
    },
  );
}
