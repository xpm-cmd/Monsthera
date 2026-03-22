import { eq, and, desc, sql, type DB, tables } from "./common.js";

export function insertEventLog(db: DB, event: typeof tables.eventLogs.$inferInsert) {
  return db.insert(tables.eventLogs).values(event).returning().get();
}

export function getEventLogs(db: DB, limit = 500, since?: string) {
  if (since) {
    return db.select().from(tables.eventLogs)
      .where(sql`${tables.eventLogs.timestamp} >= ${since}`)
      .orderBy(desc(tables.eventLogs.timestamp)).limit(limit).all();
  }
  return db.select().from(tables.eventLogs).orderBy(desc(tables.eventLogs.timestamp)).limit(limit).all();
}

export function getEventLogsByAgent(db: DB, agentId: string, limit = 50) {
  return db
    .select()
    .from(tables.eventLogs)
    .where(eq(tables.eventLogs.agentId, agentId))
    .orderBy(desc(tables.eventLogs.timestamp))
    .limit(limit)
    .all();
}

export function getEventLogsBySession(db: DB, sessionId: string, limit = 50) {
  return db
    .select()
    .from(tables.eventLogs)
    .where(eq(tables.eventLogs.sessionId, sessionId))
    .orderBy(desc(tables.eventLogs.timestamp))
    .limit(limit)
    .all();
}

// --- Debug Payloads ---

export function insertDebugPayload(db: DB, payload: typeof tables.debugPayloads.$inferInsert) {
  return db.insert(tables.debugPayloads).values(payload).returning().get();
}

export function cleanExpiredPayloads(db: DB) {
  const now = new Date().toISOString();
  return db.delete(tables.debugPayloads).where(sql`${tables.debugPayloads.expiresAt} < ${now}`).run();
}

/** Delete event_logs older than the given cutoff ISO timestamp. */
export function cleanOldEventLogs(db: DB, olderThan: string) {
  return db.delete(tables.eventLogs).where(sql`${tables.eventLogs.timestamp} < ${olderThan}`).run();
}

/** Delete coordination_messages older than the given cutoff ISO timestamp. */
export function cleanOldCoordinationMessages(db: DB, olderThan: string) {
  return db.delete(tables.coordinationMessages).where(sql`${tables.coordinationMessages.timestamp} < ${olderThan}`).run();
}

// --- Dashboard Events ---

export function insertDashboardEvent(
  db: DB,
  event: typeof tables.dashboardEvents.$inferInsert,
): typeof tables.dashboardEvents.$inferSelect {
  return db.insert(tables.dashboardEvents).values(event).returning().get();
}

export function getDashboardEventsByRepo(
  db: DB,
  repoId: number,
  opts?: { afterId?: number; since?: string; limit?: number },
) {
  const conditions = [eq(tables.dashboardEvents.repoId, repoId)];

  if (opts?.afterId !== undefined) {
    conditions.push(sql`${tables.dashboardEvents.id} > ${opts.afterId}`);
  }

  if (opts?.since) {
    conditions.push(sql`${tables.dashboardEvents.timestamp} > ${opts.since}`);
  }

  const query = db
    .select()
    .from(tables.dashboardEvents)
    .where(and(...conditions))
    .orderBy(tables.dashboardEvents.id);

  return opts?.limit ? query.limit(opts.limit).all() : query.all();
}

export function getLatestDashboardEventId(db: DB, repoId: number): number {
  const latest = db
    .select({ id: tables.dashboardEvents.id })
    .from(tables.dashboardEvents)
    .where(eq(tables.dashboardEvents.repoId, repoId))
    .orderBy(desc(tables.dashboardEvents.id))
    .get();
  return latest?.id ?? 0;
}

export function getLatestTicketSyncCursor(db: DB, repoId: number): string {
  const row = db.select({
    ticketCount: sql<number>`(
      select count(*)
      from tickets
      where repo_id = ${repoId}
    )`,
    latestTicketUpdatedAt: sql<string | null>`(
      select max(updated_at)
      from tickets
      where repo_id = ${repoId}
    )`,
    historyCount: sql<number>`(
      select count(*)
      from ticket_history h
      inner join tickets t on t.id = h.ticket_id
      where t.repo_id = ${repoId}
    )`,
    latestHistoryAt: sql<string | null>`(
      select max(h.timestamp)
      from ticket_history h
      inner join tickets t on t.id = h.ticket_id
      where t.repo_id = ${repoId}
    )`,
    commentCount: sql<number>`(
      select count(*)
      from ticket_comments c
      inner join tickets t on t.id = c.ticket_id
      where t.repo_id = ${repoId}
    )`,
    latestCommentAt: sql<string | null>`(
      select max(c.created_at)
      from ticket_comments c
      inner join tickets t on t.id = c.ticket_id
      where t.repo_id = ${repoId}
    )`,
    verdictCount: sql<number>`(
      select count(*)
      from review_verdicts v
      inner join tickets t on t.id = v.ticket_id
      where t.repo_id = ${repoId}
    )`,
    latestVerdictAt: sql<string | null>`(
      select max(v.created_at)
      from review_verdicts v
      inner join tickets t on t.id = v.ticket_id
      where t.repo_id = ${repoId}
    )`,
    dependencyCount: sql<number>`(
      select count(*)
      from ticket_dependencies d
      inner join tickets t on t.id = d.from_ticket_id
      where t.repo_id = ${repoId}
    )`,
    latestDependencyAt: sql<string | null>`(
      select max(d.created_at)
      from ticket_dependencies d
      inner join tickets t on t.id = d.from_ticket_id
      where t.repo_id = ${repoId}
    )`,
    linkedPatchCount: sql<number>`(
      select count(*)
      from patches p
      inner join tickets t on t.id = p.ticket_id
      where t.repo_id = ${repoId}
    )`,
    latestLinkedPatchAt: sql<string | null>`(
      select max(p.updated_at)
      from patches p
      inner join tickets t on t.id = p.ticket_id
      where t.repo_id = ${repoId}
    )`,
  }).from(tables.repos).where(eq(tables.repos.id, repoId)).get();

  return JSON.stringify(row ?? {
    ticketCount: 0,
    latestTicketUpdatedAt: null,
    historyCount: 0,
    latestHistoryAt: null,
    commentCount: 0,
    latestCommentAt: null,
    verdictCount: 0,
    latestVerdictAt: null,
    dependencyCount: 0,
    latestDependencyAt: null,
    linkedPatchCount: 0,
    latestLinkedPatchAt: null,
  });
}
