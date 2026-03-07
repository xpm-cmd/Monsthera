import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import { resolveAgent } from "./resolve-agent.js";
import type { MessageType } from "../../schemas/coordination.js";

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
      payload: z.record(z.string(), z.unknown()).describe("Message payload"),
      to: z.string().nullable().default(null).describe("Target agent ID (null=broadcast)"),
      agentId: z.string().describe("Sending agent ID"),
      sessionId: z.string().describe("Active session ID"),
    },
    async ({ type, payload, to, agentId, sessionId }) => {
      const c = await getContext();

      const resolved = resolveAgent(c, agentId, sessionId);
      if (!resolved) {
        return {
          content: [{ type: "text" as const, text: "Agent or session not found / inactive" }],
          isError: true,
        };
      }

      const msg = c.bus.send({
        from: agentId,
        to,
        type: type as MessageType,
        payload,
      });

      c.insight.debug(`[coord] ${type} from ${agentId} → ${to ?? "all"}`);

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
      agentId: z.string().describe("Your agent ID"),
      since: z.string().optional().describe("ISO timestamp to get messages after"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max messages"),
    },
    async ({ agentId, since, limit }) => {
      const c = await getContext();
      const messages = c.bus.getMessages(agentId, since, limit);

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
