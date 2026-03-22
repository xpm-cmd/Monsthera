import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { MonstheraContext } from "../core/context.js";
import { AgentIdSchema, SessionIdSchema } from "../core/input-hardening.js";
import { resolveAgent } from "./resolve-agent.js";
import { checkToolAccess } from "../trust/tiers.js";
import { registerAgent } from "../agents/registry.js";
import * as queries from "../db/queries.js";
import { createAgentWorktree } from "../git/worktree.js";
import { createConvoyWorktree } from "../waves/integration-branch.js";
import { pathsOverlap } from "../core/path-overlap.js";
import { HEARTBEAT_TIMEOUT_MS } from "../core/constants.js";

type GetContext = () => Promise<MonstheraContext>;

export function registerSpawnTools(server: McpServer, getContext: GetContext): void {
  // ─── spawn_agent ──────────────────────────────────────────
  server.tool(
    "spawn_agent",
    "Spawn a new agent with worktree and file claims for a ticket (facilitator/admin only)",
    {
      ticketId: z.string().min(1).describe("Ticket ID (TKT-...)"),
      role: z.enum(["developer", "reviewer"]).default("developer").describe("Role for spawned agent"),
      agentId: AgentIdSchema,
      sessionId: SessionIdSchema,
    },
    async ({ ticketId, role, agentId, sessionId }) => {
      const c = await getContext();

      // 1. Resolve caller and check access
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: resolved.error }) }], isError: true };
      }

      const access = checkToolAccess("spawn_agent", resolved.agent.role, resolved.agent.trustTier);
      if (!access.allowed) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ denied: true, reason: access.reason }) }], isError: true };
      }

      // 2. Look up ticket
      const ticket = queries.getTicketByTicketId(c.db, ticketId, c.repoId);
      if (!ticket) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Ticket ${ticketId} not found` }) }], isError: true };
      }

      // 3. Register spawned agent with stable name
      const spawnName = `spawn-${role}-${ticketId.slice(4, 16)}`;
      let registration;
      try {
        registration = registerAgent(
          c.db,
          {
            name: spawnName,
            type: "spawned",
            desiredRole: role,
          },
          { registrationAuth: c.config.registrationAuth },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Failed to register agent: ${msg}` }) }], isError: true };
      }

      const spawnedAgentId = registration.agentId;
      const spawnedSessionId = registration.sessionId;

      // 4. Create worktree (convoy-aware)
      let worktreePath: string;
      let branchName: string;
      let convoyAware = false;

      try {
        const convoyInfo = queries.getLaunchedWorkGroupsForTicket(c.db, ticket.id);
        if (convoyInfo.length > 0 && convoyInfo[0]!.integrationBranch) {
          const wt = await createConvoyWorktree(
            c.repoPath,
            spawnedSessionId,
            convoyInfo[0]!.integrationBranch,
          );
          worktreePath = wt.worktreePath;
          branchName = wt.branchName;
          convoyAware = true;
        } else {
          const wt = await createAgentWorktree(c.repoPath, spawnedSessionId);
          worktreePath = wt.worktreePath;
          branchName = wt.branchName;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Failed to create worktree: ${msg}` }) }], isError: true };
      }

      // 5. Claim affected files
      let claimResult: { ok: boolean; conflicts: unknown[] } = { ok: true, conflicts: [] };
      try {
        const affectedPaths: string[] = ticket.affectedPathsJson
          ? JSON.parse(ticket.affectedPathsJson)
          : [];
        if (affectedPaths.length > 0) {
          const cutoff = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString();
          claimResult = queries.claimFilesAtomic(
            c.db,
            spawnedSessionId,
            affectedPaths,
            "advisory",
            cutoff,
            pathsOverlap,
          );
        }
      } catch {
        // Non-critical — claim failures don't block spawn
      }

      // 6. Assign ticket to spawned agent
      try {
        queries.updateTicket(c.db, ticket.id, { assigneeAgentId: spawnedAgentId });
      } catch {
        // Non-critical
      }

      c.insight.info(`Spawned agent ${spawnedAgentId} (${spawnName}) for ${ticketId} in ${worktreePath}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            spawnedAgentId,
            spawnedSessionId,
            worktreePath,
            branchName,
            ticketId,
            role,
            convoyAware,
            claimConflicts: claimResult.conflicts,
          }, null, 2),
        }],
      };
    },
  );
}
