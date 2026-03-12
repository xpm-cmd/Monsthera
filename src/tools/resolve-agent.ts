import type { AgoraContext } from "../core/context.js";
import * as queries from "../db/queries.js";
import { touchSession } from "../agents/registry.js";
import type { RoleId } from "../../schemas/agent.js";
import type { TrustTier } from "../../schemas/evidence-bundle.js";

export interface ResolvedAgent {
  agentId: string;
  sessionId: string;
  role: RoleId;
  trustTier: TrustTier;
}

export type ResolveAgentResult =
  | { ok: true; agent: ResolvedAgent }
  | { ok: false; error: string };

export function resolveAgent(
  ctx: AgoraContext,
  agentId?: string,
  sessionId?: string,
): ResolveAgentResult {
  if (!agentId || !sessionId) {
    return { ok: false, error: "Missing agentId or sessionId. Call register_agent first to obtain both." };
  }

  const agent = queries.getAgent(ctx.db, agentId);
  if (!agent) {
    return { ok: false, error: `Agent not found: ${agentId}. Call register_agent to create an agent and session.` };
  }

  const session = queries.getSession(ctx.db, sessionId);
  if (!session) {
    return { ok: false, error: `Session not found: ${sessionId}. Call register_agent to create a new session.` };
  }

  if (session.agentId !== agentId) {
    return { ok: false, error: `Session ${sessionId} belongs to a different agent. Use the sessionId returned by register_agent.` };
  }

  if (session.state !== "active") {
    return { ok: false, error: `Session ${sessionId} is ${session.state}. Call register_agent to create a new session.` };
  }

  // Update lastActivity — enables live presence tracking in the dashboard
  touchSession(ctx.db, session.id);

  return {
    ok: true,
    agent: {
      agentId: agent.id,
      sessionId: session.id,
      role: agent.roleId as RoleId,
      trustTier: agent.trustTier as TrustTier,
    },
  };
}
