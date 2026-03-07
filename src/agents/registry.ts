import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as tables from "../db/schema.js";
import * as queries from "../db/queries.js";
import { BUILT_IN_ROLES, type RoleId } from "../../schemas/agent.js";
import type { TrustTier } from "../../schemas/evidence-bundle.js";

export interface RegisterResult {
  agentId: string;
  sessionId: string;
  role: RoleId;
  trustTier: TrustTier;
}

export function registerAgent(
  db: BetterSQLite3Database<typeof schema>,
  input: { name: string; type: string; desiredRole: RoleId },
): RegisterResult {
  const now = new Date().toISOString();
  const agentId = `agent-${randomUUID().slice(0, 8)}`;
  const sessionId = `session-${randomUUID().slice(0, 8)}`;

  const role = BUILT_IN_ROLES[input.desiredRole] ?? BUILT_IN_ROLES.observer;
  const trustTier = role.permissions.trustTier;

  queries.upsertAgent(db, {
    id: agentId,
    name: input.name,
    type: input.type,
    roleId: input.desiredRole,
    trustTier,
    registeredAt: now,
  });

  queries.insertSession(db, {
    id: sessionId,
    agentId,
    state: "active",
    connectedAt: now,
    lastActivity: now,
  });

  return { agentId, sessionId, role: input.desiredRole, trustTier };
}

export function getAgentStatus(
  db: BetterSQLite3Database<typeof schema>,
  agentId: string,
) {
  const agent = queries.getAgent(db, agentId);
  if (!agent) return null;

  const allSessions = db
    .select()
    .from(tables.sessions)
    .where(eq(tables.sessions.agentId, agentId))
    .all();

  return {
    agent,
    sessions: allSessions,
    activeSessions: allSessions.filter((s) => s.state === "active"),
  };
}

export function touchSession(
  db: BetterSQLite3Database<typeof schema>,
  sessionId: string,
): void {
  queries.updateSessionActivity(db, sessionId);
}

export function disconnectSession(
  db: BetterSQLite3Database<typeof schema>,
  sessionId: string,
): void {
  queries.updateSessionState(db, sessionId, "disconnected");
  queries.updateSessionClaims(db, sessionId, []);
}
