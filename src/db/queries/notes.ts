import { eq, and, desc, type DB, tables } from "./common.js";

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
