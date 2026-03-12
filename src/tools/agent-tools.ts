import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import { AgentIdentitySource } from "../../schemas/agent.js";
import {
  AgentIdSchema,
  ClaimPathsSchema,
  SessionIdSchema,
  parseStringArrayJson,
} from "../core/input-hardening.js";
import { AgentRegistrationError, registerAgent, getAgentStatus, reapStaleSessions, disconnectSession } from "../agents/registry.js";
import * as queries from "../db/queries.js";
import { checkToolAccess } from "../trust/tiers.js";
import { resolveAgent } from "./resolve-agent.js";
import { HEARTBEAT_TIMEOUT_MS } from "../core/constants.js";

type GetContext = () => Promise<AgoraContext>;

export function registerAgentTools(server: McpServer, getContext: GetContext): void {
  // ─── register_agent ─────────────────────────────────────────
  server.tool(
    "register_agent",
    "Register an agent and create a session",
    {
      name: z.string().min(1).max(100).describe("Agent display name"),
      type: z.string().max(50).default("unknown").describe("Agent type (e.g. claude-code)"),
      provider: z.string().trim().min(1).max(100).optional().describe("Optional normalized model provider"),
      model: z.string().trim().min(1).max(200).optional().describe("Optional normalized model name"),
      modelFamily: z.string().trim().min(1).max(100).optional().describe("Optional model family identifier"),
      modelVersion: z.string().trim().min(1).max(100).optional().describe("Optional model version"),
      identitySource: AgentIdentitySource.optional().describe("Optional identity provenance"),
      desiredRole: z.enum(["developer", "reviewer", "facilitator", "observer", "admin"]).default("observer").describe("Requested role"),
      authToken: z.string().min(1).max(200).optional().describe("Optional registration token for privileged roles"),
    },
    async ({ name, type, provider, model, modelFamily, modelVersion, identitySource, desiredRole, authToken }) => {
      const c = await getContext();
      try {
        const result = registerAgent(
          c.db,
          { name, type, provider, model, modelFamily, modelVersion, identitySource, desiredRole, authToken },
          { registrationAuth: c.config.registrationAuth },
        );
        c.insight.info(`Agent registered: ${name} (${result.agentId}) as ${result.role}`);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              agentId: result.agentId,
              sessionId: result.sessionId,
              role: result.role,
              trustTier: result.trustTier,
              identity: result.identity,
              message: `Registered as ${result.role} with trust tier ${result.trustTier}`,
            }, null, 2),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof AgentRegistrationError) {
          c.insight.warn(`Agent registration denied for ${name}: ${message}`);
        }
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    },
  );

  // ─── agent_status ───────────────────────────────────────────
  server.tool(
    "agent_status",
    "Get status of a specific agent or list all agents",
    {
      agentId: AgentIdSchema.optional().describe("Agent ID (omit for all agents)"),
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
              provider: a.provider,
              model: a.model,
              modelFamily: a.modelFamily,
              modelVersion: a.modelVersion,
              identitySource: a.identitySource,
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
      agentId: AgentIdSchema.describe("Sending agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ message, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

      const access = checkToolAccess("broadcast", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ denied: true, reason: access.reason }),
          }],
          isError: true,
        };
      }

      c.insight.info(`[broadcast from ${resolved.agentId}] ${message}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            broadcasted: true,
            sender: resolved.agentId,
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
      agentId: AgentIdSchema.describe("Your agent ID"),
      sessionId: SessionIdSchema.describe("Your session ID"),
      paths: ClaimPathsSchema.describe("File paths to claim"),
    },
    async ({ agentId, sessionId, paths }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

      const access = checkToolAccess("claim_files", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ denied: true, reason: access.reason }),
          }],
          isError: true,
        };
      }

      // Check for existing claims
      const activeSessions = queries.getLiveSessions(
        c.db,
        new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString(),
      );
      const conflicts: Array<{ path: string; claimedBy: string }> = [];

      for (const s of activeSessions) {
        if (s.id === resolved.sessionId) continue;
        const claimed = parseStringArrayJson(s.claimedFilesJson, {
          maxItems: 50,
          maxItemLength: 500,
        });
        for (const p of paths) {
          if (claimed.includes(p)) {
            conflicts.push({ path: p, claimedBy: s.agentId });
          }
        }
      }

      queries.updateSessionClaims(c.db, resolved.sessionId, paths);
      c.insight.debug(`Files claimed by ${resolved.agentId}: ${paths.join(", ")}`);

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
      agentId: AgentIdSchema.describe("Agent ID"),
      sessionId: SessionIdSchema.describe("Session ID to end"),
    },
    async ({ agentId, sessionId }) => {
      const c = await getContext();
      const agent = queries.getAgent(c.db, agentId);
      const session = queries.getSession(c.db, sessionId);

      if (!agent || !session || session.agentId !== agentId) {
        return {
          content: [{ type: "text" as const, text: "Agent or session not found / inactive" }],
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
