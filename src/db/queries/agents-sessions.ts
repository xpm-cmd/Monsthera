import { eq, and, sql, type DB, tables } from "./common.js";

// --- Agents ---

export function upsertAgent(db: DB, agent: typeof tables.agents.$inferInsert) {
  const identityFields = {
    provider: agent.provider ?? null,
    model: agent.model ?? null,
    modelFamily: agent.modelFamily ?? null,
    modelVersion: agent.modelVersion ?? null,
    identitySource: agent.identitySource ?? null,
  };
  return db.insert(tables.agents).values({
    ...agent,
    ...identityFields,
  }).onConflictDoUpdate({
    target: tables.agents.id,
    set: {
      name: agent.name,
      type: agent.type,
      ...identityFields,
      roleId: agent.roleId,
      trustTier: agent.trustTier,
    },
  }).returning().get();
}

export function getAgent(db: DB, agentId: string) {
  return db.select().from(tables.agents).where(eq(tables.agents.id, agentId)).get();
}

export function getAllAgents(db: DB) {
  return db.select().from(tables.agents).all();
}

// --- Sessions ---

export function insertSession(db: DB, session: typeof tables.sessions.$inferInsert) {
  return db.insert(tables.sessions).values(session).returning().get();
}

export function getSession(db: DB, sessionId: string) {
  return db.select().from(tables.sessions).where(eq(tables.sessions.id, sessionId)).get();
}

export function getActiveSessions(db: DB) {
  return db.select().from(tables.sessions).where(eq(tables.sessions.state, "active")).all();
}

export function getLiveSessions(db: DB, cutoffIso: string) {
  return db
    .select()
    .from(tables.sessions)
    .where(and(
      eq(tables.sessions.state, "active"),
      sql`${tables.sessions.lastActivity} >= ${cutoffIso}`,
    ))
    .all();
}

export function getAllSessions(db: DB) {
  return db.select().from(tables.sessions).all();
}

export function updateSessionActivity(db: DB, sessionId: string) {
  return db
    .update(tables.sessions)
    .set({ lastActivity: new Date().toISOString() })
    .where(eq(tables.sessions.id, sessionId))
    .run();
}

export function updateSessionState(db: DB, sessionId: string, state: string) {
  return db
    .update(tables.sessions)
    .set({ state, lastActivity: new Date().toISOString() })
    .where(eq(tables.sessions.id, sessionId))
    .run();
}

export function updateSessionClaims(db: DB, sessionId: string, claimedFiles: string[]) {
  return db
    .update(tables.sessions)
    .set({ claimedFilesJson: JSON.stringify(claimedFiles) })
    .where(eq(tables.sessions.id, sessionId))
    .run();
}

// --- Session Worktree ---

export function updateSessionWorktree(
  db: DB, sessionId: string, worktreePath: string, worktreeBranch: string,
) {
  return db.update(tables.sessions)
    .set({ worktreePath, worktreeBranch })
    .where(eq(tables.sessions.id, sessionId))
    .run();
}

export function getSessionWorktree(db: DB, sessionId: string) {
  const session = db.select({
    worktreePath: tables.sessions.worktreePath,
    worktreeBranch: tables.sessions.worktreeBranch,
  }).from(tables.sessions)
    .where(eq(tables.sessions.id, sessionId))
    .get();
  if (!session?.worktreePath || !session?.worktreeBranch) return null;
  return { worktreePath: session.worktreePath, worktreeBranch: session.worktreeBranch };
}

// --- Atomic Claims ---

export interface AtomicClaimResult {
  ok: boolean;
  conflicts: Array<{ path: string; claimedBy: string; existingClaim: string }>;
}

export function claimFilesAtomic(
  db: DB,
  sessionId: string,
  paths: string[],
  enforceMode: "advisory" | "strict",
  heartbeatCutoff: string,
  overlapFn: (a: string, b: string) => boolean,
): AtomicClaimResult {
  return db.transaction((tx) => {
    // 1. Read all live sessions' claims
    const liveSessions = tx.select().from(tables.sessions)
      .where(and(
        eq(tables.sessions.state, "active"),
        sql`${tables.sessions.lastActivity} >= ${heartbeatCutoff}`,
      ))
      .all();

    // 2. Check for conflicts
    const conflicts: AtomicClaimResult["conflicts"] = [];
    for (const session of liveSessions) {
      if (session.id === sessionId) continue;
      let claimed: string[];
      try {
        claimed = JSON.parse(session.claimedFilesJson || "[]") as string[];
        if (!Array.isArray(claimed)) claimed = [];
      } catch {
        claimed = [];
      }
      for (const requestedPath of paths) {
        const conflictClaim = claimed.find((existing) => overlapFn(existing, requestedPath));
        if (conflictClaim) {
          conflicts.push({
            path: requestedPath,
            claimedBy: session.agentId,
            existingClaim: conflictClaim,
          });
        }
      }
    }

    // 3. In strict mode with conflicts, abort
    if (enforceMode === "strict" && conflicts.length > 0) {
      return { ok: false, conflicts };
    }

    // 4. Write claims atomically
    tx.update(tables.sessions)
      .set({ claimedFilesJson: JSON.stringify(paths) })
      .where(eq(tables.sessions.id, sessionId))
      .run();

    return { ok: true, conflicts };
  });
}

// --- Commit Locks ---

/** Max time a commit lock can be held before auto-expiry (5 minutes). */
const COMMIT_LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Attempt to acquire the global commit lock.
 * Returns true if acquired, false if already held.
 * Auto-expires stale locks older than COMMIT_LOCK_TTL_MS.
 * Uses SQLite transaction for atomicity.
 */
export function acquireCommitLock(
  db: DB, sessionId: string, agentId: string, ticketId?: string,
): boolean {
  return db.transaction((tx) => {
    const existing = tx.select().from(tables.commitLocks)
      .where(sql`${tables.commitLocks.releasedAt} IS NULL`)
      .get();

    if (existing) {
      // Auto-expire stale locks from crashed sessions
      const acquiredAt = new Date(existing.acquiredAt).getTime();
      const age = Date.now() - acquiredAt;
      if (age > COMMIT_LOCK_TTL_MS) {
        tx.update(tables.commitLocks)
          .set({ releasedAt: new Date().toISOString() })
          .where(eq(tables.commitLocks.id, existing.id))
          .run();
        // Fall through to acquire new lock
      } else {
        return false;
      }
    }

    tx.insert(tables.commitLocks).values({
      sessionId, agentId, ticketId: ticketId ?? null,
      acquiredAt: new Date().toISOString(),
    }).run();
    return true;
  });
}

export function releaseCommitLock(db: DB, sessionId: string): void {
  db.update(tables.commitLocks)
    .set({ releasedAt: new Date().toISOString() })
    .where(and(
      eq(tables.commitLocks.sessionId, sessionId),
      sql`${tables.commitLocks.releasedAt} IS NULL`,
    ))
    .run();
}

export function getActiveCommitLock(db: DB) {
  return db.select().from(tables.commitLocks)
    .where(sql`${tables.commitLocks.releasedAt} IS NULL`)
    .get() ?? null;
}
