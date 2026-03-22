import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import { AgentIdSchema, SessionIdSchema, TicketIdSchema } from "../core/input-hardening.js";
import { validatePatch } from "../patches/validator.js";
import { checkToolAccess } from "../trust/tiers.js";
import * as queries from "../db/queries.js";
import { resolveAgent } from "./resolve-agent.js";
import { compileSecretPatterns } from "../trust/secret-patterns.js";
import { buildPatchListPayload } from "../patches/read-model.js";
import { recordDashboardEvent } from "../core/events.js";

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
      agentId: AgentIdSchema.describe("Proposing agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
      dryRun: z.boolean().default(false).describe("Validate only, don't persist"),
      ticketId: TicketIdSchema.optional().describe("Link patch to a ticket (TKT-...)"),
    },
    async ({ diff, message, baseCommit, bundleId, agentId, sessionId, dryRun, ticketId }) => {
      const c = await getContext();

      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

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
        secretPatterns: compileSecretPatterns(c.config?.secretPatterns ?? []),
        proposingSessionId: sessionId,
      });

      // Validate ticket exists BEFORE persisting anything
      let resolvedTicket: { id: number } | null = null;
      if (ticketId) {
        const ticket = queries.getTicketByTicketId(c.db, ticketId, c.repoId);
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
        c.lifecycle?.onPatchLinked({ ticketId: ticketId!, patchState: state });
      }

      c.insight.info(`Patch ${validation.proposalId} by ${agentId}: ${state}`);
      recordDashboardEvent(c.db, c.repoId, {
        type: "patch_proposed",
        data: {
          proposalId: validation.proposalId,
          ticketId: ticketId ?? null,
          state,
          agentId,
          message,
        },
      });

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
      limit: z.number().int().min(1).max(100).default(20).describe("Max patches to return"),
      agentId: AgentIdSchema.describe("Agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ state, limit: rawLimit, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

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

      const limit = rawLimit ?? 20;
      const payload = buildPatchListPayload(c.db, c.repoId, state);
      const hasMore = payload.patches.length > limit;
      if (hasMore) payload.patches = payload.patches.slice(0, limit);
      payload.count = payload.patches.length;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ...payload, hasMore }),
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
