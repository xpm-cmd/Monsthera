import { eq, and, desc, type DB, tables } from "./common.js";

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
