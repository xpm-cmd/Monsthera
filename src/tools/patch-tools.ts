import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import { validatePatch } from "../patches/validator.js";
import { checkToolAccess } from "../trust/tiers.js";
import * as queries from "../db/queries.js";
import { resolveAgent } from "./resolve-agent.js";
import { compileSecretPatterns } from "../trust/secret-patterns.js";

type GetContext = () => Promise<AgoraContext>;

export function registerPatchTools(server: McpServer, getContext: GetContext): void {
  // ─── propose_patch ──────────────────────────────────────────
  server.tool(
    "propose_patch",
    "Propose a code patch with stale-rejection validation (Invariant 2 & 3)",
    {
      diff: z.string().min(1).describe("Unified diff content"),
      message: z.string().min(1).max(1000).describe("Commit message"),
      baseCommit: z.string().min(7).describe("Base commit SHA"),
      bundleId: z.string().optional().describe("Evidence Bundle ID for provenance"),
      agentId: z.string().describe("Proposing agent ID"),
      sessionId: z.string().describe("Active session ID"),
      dryRun: z.boolean().default(false).describe("Validate only, don't persist"),
      ticketId: z.string().optional().describe("Link patch to a ticket (TKT-...)"),
    },
    async ({ diff, message, baseCommit, bundleId, agentId, sessionId, dryRun, ticketId }) => {
      const c = await getContext();

      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved) {
        return {
          content: [{ type: "text" as const, text: "Agent or session not found / inactive" }],
          isError: true,
        };
      }

      const access = checkToolAccess("propose_patch", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        c.insight.warn(`propose_patch denied for ${agentId}: ${access.reason}`);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ denied: true, reason: access.reason }),
          }],
          isError: true,
        };
      }

      const validation = await validatePatch(c.db, c.repoPath, c.repoId, {
        diff, message, baseCommit, bundleId,
        secretPatterns: compileSecretPatterns(c.config.secretPatterns),
      });

      // Validate ticket exists BEFORE persisting anything
      let resolvedTicket: { id: number } | null = null;
      if (ticketId) {
        const ticket = queries.getTicketByTicketId(c.db, ticketId);
        if (!ticket) {
          return {
            content: [{ type: "text" as const, text: `Ticket not found: ${ticketId}` }],
            isError: true,
          };
        }
        resolvedTicket = ticket;
      }

      if (dryRun) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              dryRun: true,
              ...validationSummary(validation),
            }, null, 2),
          }],
        };
      }

      const now = new Date().toISOString();
      const state = validation.valid ? "validated" : "stale";

      const patch = queries.insertPatch(c.db, {
        repoId: c.repoId,
        proposalId: validation.proposalId,
        baseCommit,
        bundleId: bundleId ?? null,
        state,
        diff, message,
        touchedPathsJson: JSON.stringify(validation.dryRunResult.touchedPaths),
        dryRunResultJson: JSON.stringify(validation.dryRunResult),
        agentId, sessionId,
        createdAt: now, updatedAt: now,
      });

      // Link patch to ticket (already validated above)
      if (resolvedTicket) {
        queries.linkPatchToTicket(c.db, patch.id, resolvedTicket.id);
      }

      c.insight.info(`Patch ${validation.proposalId} by ${agentId}: ${state}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ...validationSummary(validation), state, ...(ticketId && { linkedTicketId: ticketId }) }, null, 2),
        }],
      };
    },
  );

  // ─── list_patches ──────────────────────────────────────────
  server.tool(
    "list_patches",
    "List patch proposals, optionally filtered by state",
    {
      state: z.enum(["proposed", "validated", "applied", "committed", "stale", "failed"])
        .optional().describe("Filter by patch state"),
      agentId: z.string().describe("Agent ID"),
      sessionId: z.string().describe("Active session ID"),
    },
    async ({ state, agentId, sessionId }) => {
      const c = await getContext();
      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved) {
        return {
          content: [{ type: "text" as const, text: "Agent or session not found / inactive" }],
          isError: true,
        };
      }

      const access = checkToolAccess("list_patches", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ denied: true, reason: access.reason }),
          }],
          isError: true,
        };
      }

      const patches = queries.getPatchesByRepo(c.db, c.repoId, state);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: patches.length,
            patches: patches.map((p) => ({
              proposalId: p.proposalId, state: p.state,
              message: p.message, baseCommit: p.baseCommit,
              agentId: p.agentId, createdAt: p.createdAt,
            })),
          }, null, 2),
        }],
      };
    },
  );
}

function validationSummary(v: Awaited<ReturnType<typeof validatePatch>>) {
  return {
    proposalId: v.proposalId,
    valid: v.valid,
    stale: v.stale,
    currentHead: v.currentHead,
    dryRunResult: v.dryRunResult,
  };
}
