import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import * as tables from "../db/schema.js";
import * as queries from "../db/queries.js";
import {
  BUILT_IN_ROLES,
  type AgentIdentitySource,
  type RoleId,
} from "../../schemas/agent.js";
import type { TrustTier } from "../../schemas/evidence-bundle.js";
import { HEARTBEAT_TIMEOUT_MS } from "../core/constants.js";
import type { RegistrationAuth } from "../core/config.js";

export interface AgentIdentityRecord {
  provider: string | null;
  model: string | null;
  modelFamily: string | null;
  modelVersion: string | null;
  identitySource: AgentIdentitySource | null;
}

export interface RegisterResult {
  agentId: string;
  sessionId: string;
  role: RoleId;
  trustTier: TrustTier;
  identity: AgentIdentityRecord;
}

export class AgentRegistrationError extends Error {}

export function registerAgent(
  db: BetterSQLite3Database<typeof schema>,
  input: {
    name: string;
    type: string;
    provider?: string;
    model?: string;
    modelFamily?: string;
    modelVersion?: string;
    identitySource?: AgentIdentitySource;
    desiredRole: RoleId;
    authToken?: string;
  },
  opts?: { registrationAuth?: RegistrationAuth },
): RegisterResult {
  const now = new Date().toISOString();
  const agentId = `agent-${randomUUID().slice(0, 8)}`;
  const sessionId = `session-${randomUUID().slice(0, 8)}`;

  const effectiveRoleId = resolveRegistrationRole(input.desiredRole, input.authToken, opts?.registrationAuth);
  const role = BUILT_IN_ROLES[effectiveRoleId] ?? BUILT_IN_ROLES.observer;
  const trustTier = role.permissions.trustTier;
  const identity = normalizeIdentity(input);

  db.transaction((tx) => {
    const existing = tx.select().from(tables.agents).where(eq(tables.agents.id, agentId)).get();
    if (existing) {
      tx.update(tables.agents)
        .set({
          name: input.name,
          type: input.type,
          ...identity,
          roleId: effectiveRoleId,
          trustTier,
        })
        .where(eq(tables.agents.id, agentId))
        .run();
    } else {
      tx.insert(tables.agents).values({
        id: agentId,
        name: input.name,
        type: input.type,
        ...identity,
        roleId: effectiveRoleId,
        trustTier,
        registeredAt: now,
      }).run();
    }

    tx.insert(tables.sessions).values({
      id: sessionId,
      agentId,
      state: "active",
      connectedAt: now,
      lastActivity: now,
    }).run();
  });

  return { agentId, sessionId, role: effectiveRoleId, trustTier, identity };
}

function normalizeIdentity(input: {
  provider?: string;
  model?: string;
  modelFamily?: string;
  modelVersion?: string;
  identitySource?: AgentIdentitySource;
}): AgentIdentityRecord {
  const provider = input.provider?.trim() || null;
  const model = input.model?.trim() || null;
  const modelFamily = input.modelFamily?.trim() || null;
  const modelVersion = input.modelVersion?.trim() || null;
  const hasAnyIdentity = Boolean(provider || model || modelFamily || modelVersion || input.identitySource);

  return {
    provider,
    model,
    modelFamily,
    modelVersion,
    identitySource: input.identitySource ?? (hasAnyIdentity ? "self_declared" : null),
  };
}

function resolveRegistrationRole(
  desiredRole: RoleId,
  authToken: string | undefined,
  registrationAuth: RegistrationAuth | undefined,
): RoleId {
  if (!registrationAuth?.enabled) {
    return desiredRole;
  }

  const expectedToken = registrationAuth.roleTokens[desiredRole];

  if (desiredRole === "observer") {
    if (registrationAuth.observerOpenRegistration) {
      return "observer";
    }
    if (expectedToken && authToken === expectedToken) {
      return "observer";
    }
    throw new AgentRegistrationError("Observer registration is closed and requires a valid authToken");
  }

  if (!expectedToken) {
    throw new AgentRegistrationError(`Role ${desiredRole} is not configured for self-registration`);
  }

  if (authToken !== expectedToken) {
    throw new AgentRegistrationError(`Invalid authToken for role ${desiredRole}`);
  }

  return desiredRole;
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

/**
 * Reap stale sessions: disconnect active sessions whose lastActivity
 * exceeds HEARTBEAT_TIMEOUT_MS. Returns the number of sessions reaped.
 */
export function reapStaleSessions(
  db: BetterSQLite3Database<typeof schema>,
): number {
  return db.transaction((tx) => {
    const now = Date.now();
    const active = tx.select().from(tables.sessions).where(eq(tables.sessions.state, "active")).all();
    let reaped = 0;

    for (const s of active) {
      const lastMs = new Date(s.lastActivity).getTime();
      if (Number.isNaN(lastMs) || now - lastMs > HEARTBEAT_TIMEOUT_MS) {
        tx.update(tables.sessions)
          .set({ state: "disconnected", lastActivity: new Date().toISOString() })
          .where(eq(tables.sessions.id, s.id))
          .run();
        tx.update(tables.sessions)
          .set({ claimedFilesJson: JSON.stringify([]) })
          .where(eq(tables.sessions.id, s.id))
          .run();
        reaped++;
      }
    }

    return reaped;
  });
}
