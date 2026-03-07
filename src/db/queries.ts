import { eq, and, like, desc, sql } from "drizzle-orm";
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
