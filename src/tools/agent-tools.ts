import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import { registerAgent, getAgentStatus, touchSession, reapStaleSessions, disconnectSession } from "../agents/registry.js";
import * as queries from "../db/queries.js";

type GetContext = () => Promise<AgoraContext>;

export function registerAgentTools(server: McpServer, getContext: GetContext): void {
  // ─── register_agent ─────────────────────────────────────────
  server.tool(
    "register_agent",
    "Register an agent and create a session",
    {
      name: z.string().min(1).max(100).describe("Agent display name"),
      type: z.string().max(50).default("unknown").describe("Agent type (e.g. claude-code)"),
      desiredRole: z.enum(["developer", "reviewer", "observer", "admin"]).default("observer").describe("Requested role"),
    },
    async ({ name, type, desiredRole }) => {
      const c = await getContext();
      const result = registerAgent(c.db, { name, type, desiredRole });
      c.insight.info(`Agent registered: ${name} (${result.agentId}) as ${result.role}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            agentId: result.agentId,
            sessionId: result.sessionId,
            role: result.role,
            trustTier: result.trustTier,
            message: `Registered as ${result.role} with trust tier ${result.trustTier}`,
          }, null, 2),
        }],
      };
    },
  );

  // ─── agent_status ───────────────────────────────────────────
  server.tool(
    "agent_status",
    "Get status of a specific agent or list all agents",
    {
      agentId: z.string().optional().describe("Agent ID (omit for all agents)"),
    },
    async ({ agentId }) => {
      const c = await getContext();

      if (agentId) {
        const status = getAgentStatus(c.db, agentId);
        if (!status) {
          return {
            content: [{ type: "text" as const, text: `Agent not found: ${agentId}` }],
            isError: true,
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              agent: status.agent,
              totalSessions: status.sessions.length,
              activeSessions: status.activeSessions.length,
              sessions: status.sessions,
            }, null, 2),
          }],
        };
      }

      // Lifecycle cleanup: reap stale sessions before building response
      const reaped = reapStaleSessions(c.db);

      const agents = queries.getAllAgents(c.db);
      const allSessions = queries.getAllSessions(c.db);
      const activeCount = allSessions.filter((s) => s.state === "active").length;

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            totalAgents: agents.length,
            totalSessions: allSessions.length,
            activeSessions: activeCount,
            reapedSessions: reaped,
            agents: agents.map((a) => ({
              id: a.id,
              name: a.name,
              type: a.type,
              role: a.roleId,
              trustTier: a.trustTier,
              registeredAt: a.registeredAt,
            })),
            sessions: allSessions.map((s) => ({
              id: s.id,
              agentId: s.agentId,
              state: s.state,
              connectedAt: s.connectedAt,
              lastActivity: s.lastActivity,
            })),
          }, null, 2),
        }],
      };
    },
  );

  // ─── broadcast ──────────────────────────────────────────────
  server.tool(
    "broadcast",
    "Send a coordination message to other agents via the Insight Stream",
    {
      message: z.string().min(1).max(500).describe("Message to broadcast"),
      agentId: z.string().optional().describe("Sending agent ID"),
    },
    async ({ message, agentId }) => {
      const c = await getContext();
      const sender = agentId ?? "anonymous";
      c.insight.info(`[broadcast from ${sender}] ${message}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            broadcasted: true,
            sender,
            message,
            timestamp: new Date().toISOString(),
          }, null, 2),
        }],
      };
    },
  );

  // ─── claim_files ────────────────────────────────────────────
  server.tool(
    "claim_files",
    "Claim files to prevent double-work (advisory, not a hard lock)",
    {
      sessionId: z.string().describe("Your session ID"),
      paths: z.array(z.string().min(1)).min(1).max(50).describe("File paths to claim"),
    },
    async ({ sessionId, paths }) => {
      const c = await getContext();
      const session = queries.getSession(c.db, sessionId);

      if (!session) {
        return {
          content: [{ type: "text" as const, text: `Session not found: ${sessionId}` }],
          isError: true,
        };
      }

      touchSession(c.db, sessionId);

      // Check for existing claims
      const activeSessions = queries.getActiveSessions(c.db);
      const conflicts: Array<{ path: string; claimedBy: string }> = [];

      for (const s of activeSessions) {
        if (s.id === sessionId) continue;
        const claimed = s.claimedFilesJson ? JSON.parse(s.claimedFilesJson) as string[] : [];
        for (const p of paths) {
          if (claimed.includes(p)) {
            conflicts.push({ path: p, claimedBy: s.agentId });
          }
        }
      }

      queries.updateSessionClaims(c.db, sessionId, paths);
      c.insight.debug(`Files claimed by ${session.agentId}: ${paths.join(", ")}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            claimed: paths,
            conflicts,
            warning: conflicts.length > 0 ? "Some files are already claimed by other agents" : null,
          }, null, 2),
        }],
      };
    },
  );

  // ─── end_session ─────────────────────────────────────────────
  server.tool(
    "end_session",
    "End a session when an agent finishes its work. Releases file claims and marks session as disconnected.",
    {
      sessionId: z.string().describe("Session ID to end"),
    },
    async ({ sessionId }) => {
      const c = await getContext();
      const session = queries.getSession(c.db, sessionId);

      if (!session) {
        return {
          content: [{ type: "text" as const, text: `Session not found: ${sessionId}` }],
          isError: true,
        };
      }

      if (session.state === "disconnected") {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ ended: false, reason: "Session already disconnected", sessionId }, null, 2),
          }],
        };
      }

      disconnectSession(c.db, sessionId);
      c.insight.info(`Session ended: ${sessionId} (agent: ${session.agentId})`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ ended: true, sessionId, agentId: session.agentId }, null, 2),
        }],
      };
    },
  );
}
