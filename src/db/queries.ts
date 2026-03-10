import { eq, and, like, desc, sql, notInArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema.js";
import * as tables from "./schema.js";

type DB = BetterSQLite3Database<typeof schema>;

// --- Repos ---

export function upsertRepo(db: DB, path: string, name: string): { id: number } {
  const existing = db.select().from(tables.repos).where(eq(tables.repos.path, path)).get();
  if (existing) return { id: existing.id };

  return db
    .insert(tables.repos)
    .values({ path, name, createdAt: new Date().toISOString() })
    .returning({ id: tables.repos.id })
    .get();
}

export function getRepo(db: DB, path: string) {
  return db.select().from(tables.repos).where(eq(tables.repos.path, path)).get();
}

// --- Files ---

export function getFileByPath(db: DB, repoId: number, path: string) {
  return db
    .select()
    .from(tables.files)
    .where(and(eq(tables.files.repoId, repoId), eq(tables.files.path, path)))
    .get();
}

export function searchFilesByPath(db: DB, repoId: number, pattern: string) {
  return db
    .select()
    .from(tables.files)
    .where(and(eq(tables.files.repoId, repoId), like(tables.files.path, `%${pattern}%`)))
    .all();
}

export function getFilesByLanguage(db: DB, repoId: number, language: string) {
  return db
    .select()
    .from(tables.files)
    .where(and(eq(tables.files.repoId, repoId), eq(tables.files.language, language)))
    .all();
}

export function getFilesWithSecrets(db: DB, repoId: number) {
  return db
    .select()
    .from(tables.files)
    .where(and(eq(tables.files.repoId, repoId), eq(tables.files.hasSecrets, true)))
    .all();
}

export function getAllFiles(db: DB, repoId: number) {
  return db.select().from(tables.files).where(eq(tables.files.repoId, repoId)).all();
}

export function getFileCount(db: DB, repoId: number): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(tables.files)
    .where(eq(tables.files.repoId, repoId))
    .get();
  return result?.count ?? 0;
}

// --- Imports ---

export function getImportsForFile(db: DB, fileId: number) {
  return db.select().from(tables.imports).where(eq(tables.imports.sourceFileId, fileId)).all();
}

export function getFilesImporting(db: DB, targetPath: string) {
  return db
    .select()
    .from(tables.imports)
    .innerJoin(tables.files, eq(tables.imports.sourceFileId, tables.files.id))
    .where(like(tables.imports.targetPath, `%${targetPath}%`))
    .all();
}

// --- Index State ---

export function getIndexState(db: DB, repoId: number) {
  return db.select().from(tables.indexState).where(eq(tables.indexState.repoId, repoId)).get();
}

// --- Notes ---

export function insertNote(
  db: DB,
  note: typeof tables.notes.$inferInsert,
): typeof tables.notes.$inferSelect {
  return db.insert(tables.notes).values(note).returning().get();
}

export function getNoteByKey(db: DB, key: string) {
  return db.select().from(tables.notes).where(eq(tables.notes.key, key)).get();
}

export function getNotesByRepo(db: DB, repoId: number, type?: string) {
  if (type) {
    return db
      .select()
      .from(tables.notes)
      .where(and(eq(tables.notes.repoId, repoId), eq(tables.notes.type, type)))
      .orderBy(desc(tables.notes.updatedAt))
      .all();
  }
  return db
    .select()
    .from(tables.notes)
    .where(eq(tables.notes.repoId, repoId))
    .orderBy(desc(tables.notes.updatedAt))
    .all();
}

export function updateNote(db: DB, key: string, content: string) {
  return db
    .update(tables.notes)
    .set({ content, updatedAt: new Date().toISOString() })
    .where(eq(tables.notes.key, key))
    .run();
}

// --- Patches ---

export function insertPatch(
  db: DB,
  patch: typeof tables.patches.$inferInsert,
): typeof tables.patches.$inferSelect {
  return db.insert(tables.patches).values(patch).returning().get();
}

export function getPatchByProposalId(db: DB, proposalId: string) {
  return db.select().from(tables.patches).where(eq(tables.patches.proposalId, proposalId)).get();
}

export function getPatchesByRepo(db: DB, repoId: number, state?: string) {
  if (state) {
    return db
      .select()
      .from(tables.patches)
      .where(and(eq(tables.patches.repoId, repoId), eq(tables.patches.state, state)))
      .orderBy(desc(tables.patches.createdAt))
      .all();
  }
  return db
    .select()
    .from(tables.patches)
    .where(eq(tables.patches.repoId, repoId))
    .orderBy(desc(tables.patches.createdAt))
    .all();
}

export function updatePatchState(db: DB, proposalId: string, state: string) {
  return db
    .update(tables.patches)
    .set({ state, updatedAt: new Date().toISOString() })
    .where(eq(tables.patches.proposalId, proposalId))
    .run();
}

// --- Agents ---

export function upsertAgent(db: DB, agent: typeof tables.agents.$inferInsert) {
  const existing = db.select().from(tables.agents).where(eq(tables.agents.id, agent.id)).get();
  if (existing) {
    db.update(tables.agents)
      .set({ name: agent.name, type: agent.type, roleId: agent.roleId, trustTier: agent.trustTier })
      .where(eq(tables.agents.id, agent.id))
      .run();
    return existing;
  }
  return db.insert(tables.agents).values(agent).returning().get();
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

// --- Event Logs ---

export function insertEventLog(db: DB, event: typeof tables.eventLogs.$inferInsert) {
  return db.insert(tables.eventLogs).values(event).returning().get();
}

export function getEventLogs(db: DB, limit = 50) {
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

// --- Knowledge ---

export function upsertKnowledge(
  db: DB,
  entry: typeof tables.knowledge.$inferInsert,
): typeof tables.knowledge.$inferSelect {
  const existing = db.select().from(tables.knowledge).where(eq(tables.knowledge.key, entry.key)).get();
  if (existing) {
    db.update(tables.knowledge)
      .set({
        title: entry.title,
        content: entry.content,
        tagsJson: entry.tagsJson,
        status: entry.status ?? "active",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(tables.knowledge.key, entry.key))
      .run();
    return db.select().from(tables.knowledge).where(eq(tables.knowledge.key, entry.key)).get()!;
  }
  return db.insert(tables.knowledge).values(entry).returning().get();
}

export function getKnowledgeByKey(db: DB, key: string) {
  return db.select().from(tables.knowledge).where(eq(tables.knowledge.key, key)).get();
}

export function getKnowledgeById(db: DB, id: number) {
  return db.select().from(tables.knowledge).where(eq(tables.knowledge.id, id)).get();
}

export function queryKnowledge(
  db: DB,
  opts: { type?: string; tags?: string[]; status?: string },
) {
  const conditions = [];

  conditions.push(eq(tables.knowledge.status, opts.status ?? "active"));

  if (opts.type) {
    conditions.push(eq(tables.knowledge.type, opts.type));
  }

  const results = db
    .select()
    .from(tables.knowledge)
    .where(and(...conditions))
    .orderBy(desc(tables.knowledge.updatedAt))
    .all();

  // Post-filter by tags (AND logic)
  if (opts.tags && opts.tags.length > 0) {
    return results.filter((r) => {
      const entryTags: string[] = r.tagsJson ? JSON.parse(r.tagsJson) : [];
      return opts.tags!.every((t) => entryTags.includes(t));
    });
  }

  return results;
}

export function archiveKnowledge(db: DB, key: string) {
  return db
    .update(tables.knowledge)
    .set({ status: "archived", updatedAt: new Date().toISOString() })
    .where(eq(tables.knowledge.key, key))
    .run();
}

export function deleteKnowledge(db: DB, key: string) {
  return db
    .delete(tables.knowledge)
    .where(eq(tables.knowledge.key, key))
    .run();
}

// --- Tickets ---

export function insertTicket(
  db: DB,
  ticket: typeof tables.tickets.$inferInsert,
): typeof tables.tickets.$inferSelect {
  return db.insert(tables.tickets).values(ticket).returning().get();
}

export function getTicketById(db: DB, id: number) {
  return db.select().from(tables.tickets).where(eq(tables.tickets.id, id)).get();
}

export function getTicketByTicketId(db: DB, ticketId: string) {
  return db.select().from(tables.tickets).where(eq(tables.tickets.ticketId, ticketId)).get();
}

export function updateTicket(
  db: DB,
  id: number,
  updates: Partial<Pick<
    typeof tables.tickets.$inferInsert,
    "title" | "description" | "severity" | "priority" | "tagsJson" |
    "affectedPathsJson" | "acceptanceCriteria" | "status" | "assigneeAgentId" |
    "resolvedByAgentId"
  >>,
) {
  return db
    .update(tables.tickets)
    .set({ ...updates, updatedAt: new Date().toISOString() })
    .where(eq(tables.tickets.id, id))
    .run();
}

export function getTicketsByRepo(
  db: DB,
  repoId: number,
  opts?: {
    status?: string;
    assigneeAgentId?: string;
    severity?: string;
    creatorAgentId?: string;
    tags?: string[];
    limit?: number;
  },
) {
  const conditions = [eq(tables.tickets.repoId, repoId)];

  if (opts?.status) conditions.push(eq(tables.tickets.status, opts.status));
  if (opts?.assigneeAgentId) conditions.push(eq(tables.tickets.assigneeAgentId, opts.assigneeAgentId));
  if (opts?.severity) conditions.push(eq(tables.tickets.severity, opts.severity));
  if (opts?.creatorAgentId) conditions.push(eq(tables.tickets.creatorAgentId, opts.creatorAgentId));

  const query = db
    .select()
    .from(tables.tickets)
    .where(and(...conditions))
    .orderBy(desc(tables.tickets.priority), desc(tables.tickets.updatedAt));

  const rows = (opts?.tags && opts.tags.length > 0) || opts?.limit === undefined
    ? query.all()
    : query.limit(opts.limit).all();

  const filtered = opts?.tags && opts.tags.length > 0
    ? rows.filter((ticket) => {
      const ticketTags: string[] = ticket.tagsJson ? JSON.parse(ticket.tagsJson) : [];
      return opts.tags!.every((tag) => ticketTags.includes(tag));
    })
    : rows;

  return opts?.limit !== undefined ? filtered.slice(0, opts.limit) : filtered;
}

export function getTicketCountsByStatus(db: DB, repoId: number) {
  const rows = db
    .select({
      status: tables.tickets.status,
      count: sql<number>`count(*)`,
    })
    .from(tables.tickets)
    .where(eq(tables.tickets.repoId, repoId))
    .groupBy(tables.tickets.status)
    .all();

  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = r.count;
  return counts;
}

export function getOpenTicketCount(db: DB, repoId: number): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(tables.tickets)
    .where(and(
      eq(tables.tickets.repoId, repoId),
      notInArray(tables.tickets.status, ["resolved", "closed", "wont_fix"]),
    ))
    .get();
  return result?.count ?? 0;
}

export function getTotalTicketCount(db: DB, repoId: number): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(tables.tickets)
    .where(eq(tables.tickets.repoId, repoId))
    .get();
  return result?.count ?? 0;
}

export function getTicketCountsBySeverity(db: DB, repoId: number) {
  const rows = db
    .select({
      severity: tables.tickets.severity,
      count: sql<number>`count(*)`,
    })
    .from(tables.tickets)
    .where(eq(tables.tickets.repoId, repoId))
    .groupBy(tables.tickets.severity)
    .all();

  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.severity] = row.count;
  return counts;
}

export function getOpenTicketsByRepo(db: DB, repoId: number) {
  return db
    .select()
    .from(tables.tickets)
    .where(and(
      eq(tables.tickets.repoId, repoId),
      notInArray(tables.tickets.status, ["resolved", "closed", "wont_fix"]),
    ))
    .orderBy(tables.tickets.createdAt)
    .all();
}

export function getBlockedTicketsByRepo(db: DB, repoId: number) {
  return db
    .select()
    .from(tables.tickets)
    .where(and(
      eq(tables.tickets.repoId, repoId),
      eq(tables.tickets.status, "blocked"),
    ))
    .orderBy(tables.tickets.createdAt)
    .all();
}

// --- Ticket History ---

export function insertTicketHistory(
  db: DB,
  entry: typeof tables.ticketHistory.$inferInsert,
): typeof tables.ticketHistory.$inferSelect {
  return db.insert(tables.ticketHistory).values(entry).returning().get();
}

export function getTicketHistory(db: DB, ticketInternalId: number) {
  return db
    .select()
    .from(tables.ticketHistory)
    .where(eq(tables.ticketHistory.ticketId, ticketInternalId))
    .orderBy(tables.ticketHistory.timestamp)
    .all();
}

// --- Ticket Comments ---

export function insertTicketComment(
  db: DB,
  comment: typeof tables.ticketComments.$inferInsert,
): typeof tables.ticketComments.$inferSelect {
  return db.insert(tables.ticketComments).values(comment).returning().get();
}

export function getTicketComments(db: DB, ticketInternalId: number) {
  return db
    .select()
    .from(tables.ticketComments)
    .where(eq(tables.ticketComments.ticketId, ticketInternalId))
    .orderBy(tables.ticketComments.createdAt)
    .all();
}

// --- Patch ↔ Ticket link ---

export function linkPatchToTicket(db: DB, patchInternalId: number, ticketInternalId: number) {
  return db
    .update(tables.patches)
    .set({ ticketId: ticketInternalId })
    .where(eq(tables.patches.id, patchInternalId))
    .run();
}

export function getPatchesByTicketId(db: DB, ticketInternalId: number) {
  return db
    .select()
    .from(tables.patches)
    .where(eq(tables.patches.ticketId, ticketInternalId))
    .orderBy(desc(tables.patches.createdAt))
    .all();
}

// --- Coordination Messages ---

export function insertCoordinationMessage(
  db: DB,
  message: typeof tables.coordinationMessages.$inferInsert,
): typeof tables.coordinationMessages.$inferSelect {
  return db.insert(tables.coordinationMessages).values(message).returning().get();
}

export function getCoordinationMessagesByRepo(
  db: DB,
  repoId: number,
  opts?: { since?: string; afterId?: number; limit?: number },
) {
  const conditions = [eq(tables.coordinationMessages.repoId, repoId)];

  if (opts?.since) {
    conditions.push(sql`${tables.coordinationMessages.timestamp} > ${opts.since}`);
  }

  if (opts?.afterId !== undefined) {
    conditions.push(sql`${tables.coordinationMessages.id} > ${opts.afterId}`);
  }

  const query = db
    .select()
    .from(tables.coordinationMessages)
    .where(and(...conditions))
    .orderBy(tables.coordinationMessages.id);

  return opts?.limit ? query.limit(opts.limit).all() : query.all();
}

export function getLatestCoordinationMessageId(db: DB, repoId: number): number {
  const latest = db
    .select({ id: tables.coordinationMessages.id })
    .from(tables.coordinationMessages)
    .where(eq(tables.coordinationMessages.repoId, repoId))
    .orderBy(desc(tables.coordinationMessages.id))
    .get();
  return latest?.id ?? 0;
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
