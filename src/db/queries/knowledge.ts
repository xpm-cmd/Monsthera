import { eq, and, desc, inArray, type DB, type QueryDb, tables, parseStringArrayJson } from "./common.js";

export function upsertKnowledge(
  db: QueryDb,
  entry: typeof tables.knowledge.$inferInsert,
): typeof tables.knowledge.$inferSelect {
  // Re-resolve/close updates the distilled content, but preserves the original actor/session attribution.
  return db.insert(tables.knowledge).values(entry)
    .onConflictDoUpdate({
      target: tables.knowledge.key,
      set: {
        title: entry.title,
        content: entry.content,
        tagsJson: entry.tagsJson,
        status: entry.status ?? "active",
        updatedAt: new Date().toISOString(),
      },
    })
    .returning().get();
}

export function getKnowledgeByKey(db: DB, key: string) {
  return db.select().from(tables.knowledge).where(eq(tables.knowledge.key, key)).get();
}

export function getKnowledgeById(db: DB, id: number) {
  return db.select().from(tables.knowledge).where(eq(tables.knowledge.id, id)).get();
}

export function getKnowledgeByIds(db: DB, ids: number[]) {
  if (ids.length === 0) return [];
  return db.select().from(tables.knowledge).where(inArray(tables.knowledge.id, ids)).all();
}

export function queryKnowledge(
  db: DB,
  opts: { type?: string; tags?: string[]; status?: string; limit?: number },
) {
  const conditions = [];

  conditions.push(eq(tables.knowledge.status, opts.status ?? "active"));

  if (opts.type) {
    conditions.push(eq(tables.knowledge.type, opts.type));
  }

  const effectiveLimit = opts.limit ?? 200;

  // When filtering by tags in JS, fetch more rows to compensate for post-filter
  const fetchLimit = (opts.tags && opts.tags.length > 0) ? effectiveLimit * 3 : effectiveLimit;

  const results = db
    .select()
    .from(tables.knowledge)
    .where(and(...conditions))
    .orderBy(desc(tables.knowledge.updatedAt))
    .limit(fetchLimit)
    .all();

  // Post-filter by tags (AND logic)
  if (opts.tags && opts.tags.length > 0) {
    return results.filter((r) => {
      const entryTags = parseStringArrayJson(r.tagsJson, {
        maxItems: 25,
        maxItemLength: 64,
      });
      return opts.tags!.every((t) => entryTags.includes(t));
    }).slice(0, effectiveLimit);
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
