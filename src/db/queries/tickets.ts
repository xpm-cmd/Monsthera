import { eq, and, or, desc, sql, notInArray, isNull, isNotNull, inArray, type DB, type SqliteDatabase, tables, parseStringArrayJson, isMissingTableError } from "./common.js";

const TICKET_RESOLUTION_COMMITS_COLUMN = "resolution_commits_json";
const ticketResolutionCommitsColumnCache = new WeakMap<object, boolean>();
const REVIEW_VERDICT_PENDING_REPLACEMENT = -1;
export const REVIEW_VERDICT_CLEARED_ON_RESET = 0;

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

export function getTicketByTicketId(db: DB, ticketId: string, repoId?: number) {
  const conditions = [eq(tables.tickets.ticketId, ticketId)];
  if (repoId !== undefined) conditions.push(eq(tables.tickets.repoId, repoId));
  return db.select().from(tables.tickets).where(and(...conditions)).get();
}

export function updateTicket(
  db: DB,
  id: number,
  updates: Partial<Pick<
    typeof tables.tickets.$inferInsert,
    "title" | "description" | "severity" | "priority" | "tagsJson" |
    "affectedPathsJson" | "acceptanceCriteria" | "status" | "assigneeAgentId" |
    "resolvedByAgentId" | "commitSha"
  >>,
) {
  return db
    .update(tables.tickets)
    .set({ ...updates, updatedAt: new Date().toISOString() })
    .where(eq(tables.tickets.id, id))
    .run();
}

export function getTicketResolutionCommitShas(db: DB, ticketInternalId: number): string[] {
  const sqlite = getSqliteClient(db);
  if (!sqlite || !hasTicketResolutionCommitsColumn(db)) return [];

  const row = sqlite
    .prepare(`SELECT ${TICKET_RESOLUTION_COMMITS_COLUMN} FROM tickets WHERE id = ?`)
    .get(ticketInternalId) as Record<string, string | null> | undefined;

  return parseStringArrayJson(row?.[TICKET_RESOLUTION_COMMITS_COLUMN] ?? null, {
    maxItems: 64,
    maxItemLength: 64,
  });
}

export function setTicketResolutionCommitShas(
  db: DB,
  ticketInternalId: number,
  commitShas: readonly string[],
  updatedAt = new Date().toISOString(),
): boolean {
  const sqlite = getSqliteClient(db);
  if (!sqlite || !hasTicketResolutionCommitsColumn(db)) return false;

  const normalized = normalizeCommitShas(commitShas);
  sqlite
    .prepare(`UPDATE tickets SET ${TICKET_RESOLUTION_COMMITS_COLUMN} = ?, updated_at = ? WHERE id = ?`)
    .run(normalized.length > 0 ? JSON.stringify(normalized) : null, updatedAt, ticketInternalId);
  return true;
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

  // When filtering by tags in JS, fetch a bounded superset then post-filter
  const hasTags = opts?.tags && opts.tags.length > 0;
  const effectiveLimit = opts?.limit;
  const fetchLimit = hasTags && effectiveLimit ? effectiveLimit * 3 : effectiveLimit;

  const rows = fetchLimit ? query.limit(fetchLimit).all() : query.all();

  const filtered = hasTags
    ? rows.filter((ticket) => {
      const ticketTags = parseStringArrayJson(ticket.tagsJson, {
        maxItems: 25,
        maxItemLength: 64,
      });
      return opts.tags!.every((tag) => ticketTags.includes(tag));
    })
    : rows;

  return effectiveLimit !== undefined ? filtered.slice(0, effectiveLimit) : filtered;
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
    .orderBy(
      sql`coalesce(julianday(${tables.ticketHistory.timestamp}), 0)`,
      tables.ticketHistory.id,
    )
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
    .orderBy(
      sql`coalesce(julianday(${tables.ticketComments.createdAt}), 0)`,
      tables.ticketComments.id,
    )
    .all();
}

// --- Council Assignments ---

export function upsertCouncilAssignment(
  db: DB,
  assignment: typeof tables.councilAssignments.$inferInsert,
): typeof tables.councilAssignments.$inferSelect {
  return db.insert(tables.councilAssignments).values(assignment)
    .onConflictDoUpdate({
      target: [tables.councilAssignments.ticketId, tables.councilAssignments.specialization],
      set: {
        agentId: assignment.agentId,
        assignedByAgentId: assignment.assignedByAgentId,
        assignedAt: assignment.assignedAt,
      },
    })
    .returning()
    .get();
}

export function getCouncilAssignment(
  db: DB,
  ticketInternalId: number,
  agentId: string,
  specialization: string,
) {
  try {
    return db
      .select()
      .from(tables.councilAssignments)
      .where(and(
        eq(tables.councilAssignments.ticketId, ticketInternalId),
        eq(tables.councilAssignments.agentId, agentId),
        eq(tables.councilAssignments.specialization, specialization),
      ))
      .get();
  } catch (error) {
    if (isMissingTableError(error, "council_assignments")) return undefined;
    throw error;
  }
}

export function getCouncilAssignmentsForTicket(db: DB, ticketInternalId: number) {
  try {
    return db
      .select()
      .from(tables.councilAssignments)
      .where(eq(tables.councilAssignments.ticketId, ticketInternalId))
      .orderBy(
        tables.councilAssignments.specialization,
        sql`coalesce(julianday(${tables.councilAssignments.assignedAt}), 0)`,
        tables.councilAssignments.id,
      )
      .all();
  } catch (error) {
    if (isMissingTableError(error, "council_assignments")) return [];
    throw error;
  }
}

// --- Review Verdicts ---

export function insertReviewVerdict(
  db: DB,
  verdict: typeof tables.reviewVerdicts.$inferInsert,
): typeof tables.reviewVerdicts.$inferSelect {
  return db.transaction((tx) => {
    const existing = tx
      .select()
      .from(tables.reviewVerdicts)
      .where(and(
        eq(tables.reviewVerdicts.ticketId, verdict.ticketId),
        eq(tables.reviewVerdicts.specialization, verdict.specialization),
        isNull(tables.reviewVerdicts.supersededBy),
      ))
      .orderBy(desc(tables.reviewVerdicts.id))
      .get();

    // Mark the previous active row as non-active before inserting the replacement.
    // The placeholder is only visible inside this transaction and is immediately rewritten.
    if (existing) {
      tx.update(tables.reviewVerdicts)
        .set({ supersededBy: REVIEW_VERDICT_PENDING_REPLACEMENT })
        .where(eq(tables.reviewVerdicts.id, existing.id))
        .run();
    }

    const inserted = tx.insert(tables.reviewVerdicts).values({
      ...verdict,
      supersededBy: null,
    }).returning().get();

    if (existing) {
      tx.update(tables.reviewVerdicts)
        .set({ supersededBy: inserted.id })
        .where(eq(tables.reviewVerdicts.id, existing.id))
        .run();
    }

    return inserted;
  });
}

export const upsertReviewVerdict = insertReviewVerdict;

export function getActiveReviewVerdicts(db: DB, ticketInternalId: number) {
  try {
    return db
      .select()
      .from(tables.reviewVerdicts)
      .where(and(
        eq(tables.reviewVerdicts.ticketId, ticketInternalId),
        isNull(tables.reviewVerdicts.supersededBy),
      ))
      .orderBy(
        sql`coalesce(julianday(${tables.reviewVerdicts.createdAt}), 0)`,
        tables.reviewVerdicts.id,
      )
      .all();
  } catch (error) {
    if (isMissingTableError(error, "review_verdicts")) return [];
    throw error;
  }
}

export const getReviewVerdicts = getActiveReviewVerdicts;

/**
 * Clear the currently active verdict slate for a ticket when it re-enters a gated review status.
 * This preserves the audit trail while forcing the next council cycle to submit fresh verdicts.
 */
export function clearActiveReviewVerdicts(db: DB, ticketInternalId: number): number {
  try {
    const result = db
      .update(tables.reviewVerdicts)
      .set({ supersededBy: REVIEW_VERDICT_CLEARED_ON_RESET })
      .where(and(
        eq(tables.reviewVerdicts.ticketId, ticketInternalId),
        isNull(tables.reviewVerdicts.supersededBy),
      ))
      .run();
    return result.changes;
  } catch (error) {
    if (isMissingTableError(error, "review_verdicts")) return 0;
    throw error;
  }
}

export function getActiveVerdictsByAgentForTicket(db: DB, ticketInternalId: number, agentId: string) {
  try {
    return db
      .select()
      .from(tables.reviewVerdicts)
      .where(and(
        eq(tables.reviewVerdicts.ticketId, ticketInternalId),
        eq(tables.reviewVerdicts.agentId, agentId),
        isNull(tables.reviewVerdicts.supersededBy),
      ))
      .orderBy(
        tables.reviewVerdicts.specialization,
        sql`coalesce(julianday(${tables.reviewVerdicts.createdAt}), 0)`,
        tables.reviewVerdicts.id,
      )
      .all();
  } catch (error) {
    if (isMissingTableError(error, "review_verdicts")) return [];
    throw error;
  }
}

export function getVerdictHistory(db: DB, ticketInternalId: number, specialization?: string) {
  try {
    const conditions = [eq(tables.reviewVerdicts.ticketId, ticketInternalId)];
    if (specialization) {
      conditions.push(eq(tables.reviewVerdicts.specialization, specialization));
    }

    return db
      .select()
      .from(tables.reviewVerdicts)
      .where(and(...conditions))
      .orderBy(
        tables.reviewVerdicts.specialization,
        sql`coalesce(julianday(${tables.reviewVerdicts.createdAt}), 0)`,
        tables.reviewVerdicts.id,
      )
      .all();
  } catch (error) {
    if (isMissingTableError(error, "review_verdicts")) return [];
    throw error;
  }
}

export function listVerdictsByAgent(
  db: DB,
  repoId: number,
  agentId: string,
  opts?: { ticketId?: string; specialization?: string; limit?: number },
): Array<{
  ticketId: string;
  specialization: string;
  verdict: string;
  reasoning: string;
  createdAt: string;
}> {
  try {
    const conditions = [
      eq(tables.reviewVerdicts.agentId, agentId),
      isNull(tables.reviewVerdicts.supersededBy),
      eq(tables.tickets.repoId, repoId),
    ];
    if (opts?.ticketId) {
      conditions.push(eq(tables.tickets.ticketId, opts.ticketId));
    }
    if (opts?.specialization) {
      conditions.push(eq(tables.reviewVerdicts.specialization, opts.specialization));
    }
    const limit = Math.min(opts?.limit ?? 50, 100);

    const rows = db
      .select({
        ticketId: tables.tickets.ticketId,
        specialization: tables.reviewVerdicts.specialization,
        verdict: tables.reviewVerdicts.verdict,
        reasoning: tables.reviewVerdicts.reasoning,
        createdAt: tables.reviewVerdicts.createdAt,
      })
      .from(tables.reviewVerdicts)
      .innerJoin(tables.tickets, eq(tables.reviewVerdicts.ticketId, tables.tickets.id))
      .where(and(...conditions))
      .orderBy(desc(tables.reviewVerdicts.createdAt), desc(tables.reviewVerdicts.id))
      .limit(limit)
      .all();

    return rows.map((r) => ({
      ticketId: r.ticketId,
      specialization: r.specialization,
      verdict: r.verdict,
      reasoning: r.reasoning ? (r.reasoning.length > 200 ? r.reasoning.slice(0, 200) + "\u2026" : r.reasoning) : "",
      createdAt: r.createdAt,
    }));
  } catch (error) {
    if (isMissingTableError(error, "review_verdicts")) return [];
    throw error;
  }
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

// --- Ticket Dependencies ---

export function createTicketDependency(
  db: DB,
  dep: typeof tables.ticketDependencies.$inferInsert,
) {
  return db.insert(tables.ticketDependencies).values(dep).returning().get();
}

export function deleteTicketDependency(
  db: DB,
  fromTicketId: number,
  toTicketId: number,
) {
  // Delete canonical "blocks" or "relates_to" in either direction for relates_to
  return db
    .delete(tables.ticketDependencies)
    .where(
      or(
        and(
          eq(tables.ticketDependencies.fromTicketId, fromTicketId),
          eq(tables.ticketDependencies.toTicketId, toTicketId),
        ),
        // Also handle relates_to stored in reverse direction
        and(
          eq(tables.ticketDependencies.fromTicketId, toTicketId),
          eq(tables.ticketDependencies.toTicketId, fromTicketId),
          eq(tables.ticketDependencies.relationType, "relates_to"),
        ),
      ),
    )
    .run();
}

export function getTicketDependencies(db: DB, ticketInternalId: number) {
  // Get all dependencies where this ticket is either source or target
  const outgoing = db
    .select()
    .from(tables.ticketDependencies)
    .where(eq(tables.ticketDependencies.fromTicketId, ticketInternalId))
    .all();
  const incoming = db
    .select()
    .from(tables.ticketDependencies)
    .where(eq(tables.ticketDependencies.toTicketId, ticketInternalId))
    .all();
  return { outgoing, incoming };
}

/**
 * Determine whether a changed file path overlaps with a ticket's affected path.
 * Handles exact matches and directory prefix matches (e.g. "src/tickets/" matches "src/tickets/lifecycle.ts").
 */
export function pathOverlaps(changedFile: string, ticketPath: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
  const a = norm(changedFile);
  const b = norm(ticketPath);
  if (a === b) return true;
  // Directory prefix: ticketPath ends with "/" and changedFile starts with it
  if (b.endsWith("/") && a.startsWith(b)) return true;
  // Also match if changedFile is inside the ticketPath directory (no trailing slash)
  if (!b.includes(".") && a.startsWith(b.endsWith("/") ? b : `${b}/`)) return true;
  return false;
}

/**
 * Find all ready_for_commit tickets whose affectedPaths overlap with the given changed files.
 * Uses application-side filtering since affectedPathsJson is unindexed JSON text.
 */
export function getReadyTicketsByAffectedPaths(
  db: DB,
  repoId: number,
  changedPaths: string[],
) {
  const candidates = db
    .select()
    .from(tables.tickets)
    .where(and(
      eq(tables.tickets.repoId, repoId),
      eq(tables.tickets.status, "ready_for_commit"),
    ))
    .all();

  return candidates.filter((ticket) => {
    const paths = parseStringArrayJson(ticket.affectedPathsJson, { maxItems: 100, maxItemLength: 500 });
    if (paths.length === 0) return false;
    return paths.some((ticketPath) =>
      changedPaths.some((changed) => pathOverlaps(changed, ticketPath)),
    );
  });
}

/**
 * Compute path overlap score: fraction of ticket's affectedPaths covered by changed files.
 * Returns 0-1 where 1 means all affected paths were touched.
 */
export function computePathOverlapScore(changedPaths: string[], ticketPaths: string[]): number {
  if (ticketPaths.length === 0) return 0;
  const matched = ticketPaths.filter((tp) =>
    changedPaths.some((cp) => pathOverlaps(cp, tp)),
  );
  return matched.length / ticketPaths.length;
}

/**
 * Find tickets in the given statuses whose affectedPaths overlap with changed files.
 * Returns tickets with their overlap score for confidence-based filtering.
 */
export function getTicketsByStatusesAndAffectedPaths(
  db: DB,
  repoId: number,
  changedPaths: string[],
  statuses: string[],
) {
  if (statuses.length === 0) return [];
  const candidates = db
    .select()
    .from(tables.tickets)
    .where(and(
      eq(tables.tickets.repoId, repoId),
      inArray(tables.tickets.status, statuses),
    ))
    .all();

  return candidates.flatMap((ticket) => {
    const paths = parseStringArrayJson(ticket.affectedPathsJson, { maxItems: 100, maxItemLength: 500 });
    if (paths.length === 0) return [];
    const overlapScore = computePathOverlapScore(changedPaths, paths);
    if (overlapScore === 0) return [];
    return [{ ...ticket, overlapScore }];
  });
}

/** Get all "blocks" edges for cycle detection (DAG validation). */
export function getAllBlocksEdges(db: DB) {
  return db
    .select({
      fromTicketId: tables.ticketDependencies.fromTicketId,
      toTicketId: tables.ticketDependencies.toTicketId,
    })
    .from(tables.ticketDependencies)
    .where(eq(tables.ticketDependencies.relationType, "blocks"))
    .all();
}

// --- Private helpers ---

function getSqliteClient(db: DB): SqliteDatabase | undefined {
  const directClient = (db as DB & { $client?: SqliteDatabase }).$client;
  if (directClient) return directClient;
  return (db as DB & { session?: { client?: SqliteDatabase } }).session?.client;
}

function hasTicketResolutionCommitsColumn(db: DB): boolean {
  const key = db as object;
  const cached = ticketResolutionCommitsColumnCache.get(key);
  if (cached !== undefined) return cached;

  const sqlite = getSqliteClient(db);
  if (!sqlite) return false;

  const hasColumn = (sqlite.prepare("PRAGMA table_info(tickets)").all() as Array<{ name: string }>)
    .some((column) => column.name === TICKET_RESOLUTION_COMMITS_COLUMN);
  ticketResolutionCommitsColumnCache.set(key, hasColumn);
  return hasColumn;
}

function normalizeCommitShas(commitShas: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const sha of commitShas) {
    const trimmed = sha.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}
