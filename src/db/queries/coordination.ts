import { eq, and, desc, sql, type DB, tables } from "./common.js";

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

  return query.limit(opts?.limit ?? 1000).all();
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
