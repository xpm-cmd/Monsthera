import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import { AgentIdSchema, FlatMetadataSchema, SessionIdSchema } from "../core/input-hardening.js";
import { checkToolAccess } from "../trust/tiers.js";
import { resolveAgent } from "./resolve-agent.js";
import type { MessageType } from "../../schemas/coordination.js";
import { recordDashboardEvent } from "../core/events.js";

type GetContext = () => Promise<AgoraContext>;

export function registerCoordinationTools(server: McpServer, getContext: GetContext): void {
  // ─── send_coordination ──────────────────────────────────────
  server.tool(
    "send_coordination",
    "Send a typed coordination message to specific agent(s) or broadcast",
    {
      type: z.enum([
        "task_claim", "task_release", "patch_intent",
        "conflict_alert", "status_update", "broadcast",
      ]).describe("Message type"),
      payload: FlatMetadataSchema.describe("Message payload"),
      to: AgentIdSchema.nullable().default(null).describe("Target agent ID (null=broadcast)"),
      agentId: AgentIdSchema.describe("Sending agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ type, payload, to, agentId, sessionId }) => {
      const c = await getContext();

      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

      const access = checkToolAccess("send_coordination", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ denied: true, reason: access.reason }),
          }],
          isError: true,
        };
      }

      const msg = c.bus.send({
        from: resolved.agentId,
        to,
        type: type as MessageType,
        payload,
      });

      c.insight.debug(`[coord] ${type} from ${resolved.agentId} → ${to ?? "all"}`);
      recordDashboardEvent(c.db, c.repoId, {
        type: "coordination_message_sent",
        data: {
          messageId: msg.id,
          messageType: type,
          from: resolved.agentId,
          to: to ?? "broadcast",
        },
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ sent: true, messageId: msg.id, timestamp: msg.timestamp }, null, 2),
        }],
      };
    },
  );

  // ─── poll_coordination ──────────────────────────────────────
  server.tool(
    "poll_coordination",
    "Poll coordination messages visible to this agent",
    {
      agentId: AgentIdSchema.describe("Your agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
      since: z.string().optional().describe("ISO timestamp to get messages after"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max messages"),
    },
    async ({ agentId, sessionId, since, limit }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

      const messages = c.bus.getMessages(resolved.agentId, since, limit);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            topology: c.bus.getTopology(),
            count: messages.length,
            messages,
          }, null, 2),
        }],
      };
    },
  );
}
