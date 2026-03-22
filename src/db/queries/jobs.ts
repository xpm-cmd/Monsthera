import { eq, and, sql, notInArray, type DB, tables } from "./common.js";

export function insertJobSlot(db: DB, slot: typeof tables.jobSlots.$inferInsert) {
  return db.insert(tables.jobSlots).values(slot).returning().get();
}

export function getJobSlotBySlotId(db: DB, repoId: number, slotId: string) {
  return db
    .select()
    .from(tables.jobSlots)
    .where(and(eq(tables.jobSlots.repoId, repoId), eq(tables.jobSlots.slotId, slotId)))
    .get();
}

export function getJobSlotsByLoop(db: DB, repoId: number, loopId: string, status?: string) {
  const conditions = [eq(tables.jobSlots.repoId, repoId), eq(tables.jobSlots.loopId, loopId)];
  if (status) conditions.push(eq(tables.jobSlots.status, status));
  return db.select().from(tables.jobSlots).where(and(...conditions)).all();
}

export function getJobSlotsByAgent(db: DB, agentId: string) {
  return db
    .select()
    .from(tables.jobSlots)
    .where(eq(tables.jobSlots.agentId, agentId))
    .all();
}

export function getJobSlotsByTicketId(db: DB, repoId: number, ticketId: string) {
  return db
    .select()
    .from(tables.jobSlots)
    .where(and(eq(tables.jobSlots.repoId, repoId), eq(tables.jobSlots.ticketId, ticketId)))
    .all();
}

export function getOpenSlotsByRole(db: DB, repoId: number, loopId: string, role: string) {
  return db
    .select()
    .from(tables.jobSlots)
    .where(and(
      eq(tables.jobSlots.repoId, repoId),
      eq(tables.jobSlots.loopId, loopId),
      eq(tables.jobSlots.role, role),
      eq(tables.jobSlots.status, "open"),
    ))
    .all();
}

export function updateJobSlot(
  db: DB,
  slotId: string,
  updates: Partial<typeof tables.jobSlots.$inferInsert>,
) {
  return db
    .update(tables.jobSlots)
    .set({ ...updates, updatedAt: new Date().toISOString() })
    .where(eq(tables.jobSlots.slotId, slotId))
    .run();
}

export function getDistinctLoops(db: DB, repoId: number) {
  return db
    .select({
      loopId: tables.jobSlots.loopId,
      total: sql<number>`count(*)`,
      open: sql<number>`sum(case when ${tables.jobSlots.status} = 'open' then 1 else 0 end)`,
      claimed: sql<number>`sum(case when ${tables.jobSlots.status} = 'claimed' then 1 else 0 end)`,
      active: sql<number>`sum(case when ${tables.jobSlots.status} = 'active' then 1 else 0 end)`,
      completed: sql<number>`sum(case when ${tables.jobSlots.status} = 'completed' then 1 else 0 end)`,
      abandoned: sql<number>`sum(case when ${tables.jobSlots.status} = 'abandoned' then 1 else 0 end)`,
    })
    .from(tables.jobSlots)
    .where(eq(tables.jobSlots.repoId, repoId))
    .groupBy(tables.jobSlots.loopId)
    .all();
}

export function abandonJobSlotsBySession(db: DB, sessionId: string): number {
  const now = new Date().toISOString();
  const result = db
    .update(tables.jobSlots)
    .set({ status: "abandoned", agentId: null, sessionId: null, updatedAt: now })
    .where(and(
      eq(tables.jobSlots.sessionId, sessionId),
      notInArray(tables.jobSlots.status, ["completed", "abandoned"]),
    ))
    .run();
  return result.changes;
}

export function getAllJobSlots(db: DB, repoId: number) {
  return db.select().from(tables.jobSlots).where(eq(tables.jobSlots.repoId, repoId)).all();
}
