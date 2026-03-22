import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import { AgentIdSchema, SessionIdSchema } from "../core/input-hardening.js";
import { resolveAgent } from "./resolve-agent.js";
import { checkToolAccess } from "../trust/tiers.js";
import { errText, errJson, okJson } from "./response-helpers.js";
import { getGovernanceSettings, getTicketMetrics } from "../dashboard/api.js";
import * as queries from "../db/queries.js";

type GetContext = () => Promise<AgoraContext>;

export function registerGovernanceTools(server: McpServer, getContext: GetContext): void {
  // ─── get_governance_settings ──────────────────────────────────
  server.tool(
    "get_governance_settings",
    "Get current governance policy settings (model diversity, quorum, reviewer independence)",
    {
      agentId: AgentIdSchema,
      sessionId: SessionIdSchema,
    },
    async ({ agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return errText(result.error);

      const access = checkToolAccess("get_governance_settings", result.agent.role, result.agent.trustTier);
      if (!access.allowed) return errJson({ denied: true, reason: access.reason });

      const settings = getGovernanceSettings({
        db: c.db,
        repoId: c.repoId,
        repoPath: c.repoPath,
        bus: c.bus,
        globalDb: c.globalDb,
        governance: c.config.governance,
      });

      return okJson(settings);
    },
  );

  // ─── get_ticket_metrics ───────────────────────────────────────
  server.tool(
    "get_ticket_metrics",
    "Get ticket health metrics: status counts, aging, blocked tickets, assignee load, duplicates",
    {
      agentId: AgentIdSchema,
      sessionId: SessionIdSchema,
    },
    async ({ agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return errText(result.error);

      const access = checkToolAccess("get_ticket_metrics", result.agent.role, result.agent.trustTier);
      if (!access.allowed) return errJson({ denied: true, reason: access.reason });

      const metrics = getTicketMetrics({
        db: c.db,
        repoId: c.repoId,
        repoPath: c.repoPath,
        bus: c.bus,
        globalDb: c.globalDb,
        governance: c.config.governance,
      });

      return okJson(metrics);
    },
  );

  // ─── list_events ──────────────────────────────────────────────
  server.tool(
    "list_events",
    "List recent event log entries (tool invocations, errors, denials)",
    {
      agentId: AgentIdSchema,
      sessionId: SessionIdSchema,
      limit: z.number().int().min(1).max(200).default(50).describe("Max events to return"),
      since: z.string().optional().describe("ISO timestamp lower bound"),
    },
    async ({ agentId, sessionId, limit, since }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) return errText(result.error);

      const access = checkToolAccess("list_events", result.agent.role, result.agent.trustTier);
      if (!access.allowed) return errJson({ denied: true, reason: access.reason });

      const events = queries.getEventLogs(c.db, limit, since);

      return okJson({
        count: events.length,
        events: events.map((e) => ({
          eventId: e.eventId,
          tool: e.tool,
          agentId: e.agentId,
          status: e.status,
          durationMs: e.durationMs,
          timestamp: e.timestamp,
          errorCode: e.errorCode,
        })),
      });
    },
  );
}
