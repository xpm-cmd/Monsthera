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

export function resolveAgent(
  ctx: AgoraContext,
  agentId?: string,
  sessionId?: string,
): ResolvedAgent | null {
  if (!agentId || !sessionId) return null;

  const agent = queries.getAgent(ctx.db, agentId);
  if (!agent) return null;

  const session = queries.getSession(ctx.db, sessionId);
  if (!session || session.agentId !== agentId || session.state !== "active") return null;

  // Update lastActivity — enables live presence tracking in the dashboard
  touchSession(ctx.db, session.id);

  return {
    agentId: agent.id,
    sessionId: session.id,
    role: agent.roleId as RoleId,
    trustTier: agent.trustTier as TrustTier,
  };
}
