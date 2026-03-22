import { eq, and, desc, sql, notInArray, isNotNull, type DB, tables } from "./common.js";

export function insertWorkGroup(
  db: DB,
  group: {
    repoId: number;
    groupId: string;
    title: string;
    description: string | null;
    status: string;
    createdBy: string;
    tagsJson: string | null;
    createdAt: string;
    updatedAt: string;
  },
) {
  return db.insert(tables.workGroups).values(group).returning().get();
}

export function getWorkGroupByGroupId(db: DB, groupId: string) {
  return db.select().from(tables.workGroups).where(eq(tables.workGroups.groupId, groupId)).get();
}

export function updateWorkGroup(
  db: DB,
  id: number,
  updates: {
    title?: string;
    description?: string | null;
    status?: string;
    tagsJson?: string | null;
    updatedAt: string;
  },
) {
  return db.update(tables.workGroups).set(updates).where(eq(tables.workGroups.id, id)).run();
}

export function addTicketToWorkGroup(
  db: DB,
  workGroupId: number,
  ticketId: number,
  addedAt: string,
) {
  return db.insert(tables.workGroupTickets).values({
    workGroupId,
    ticketId,
    addedAt,
  }).run();
}

export function removeTicketFromWorkGroup(
  db: DB,
  workGroupId: number,
  ticketId: number,
) {
  return db.delete(tables.workGroupTickets).where(
    and(
      eq(tables.workGroupTickets.workGroupId, workGroupId),
      eq(tables.workGroupTickets.ticketId, ticketId),
    ),
  ).run();
}

export function getWorkGroupTickets(db: DB, workGroupId: number) {
  return db
    .select()
    .from(tables.workGroupTickets)
    .innerJoin(tables.tickets, eq(tables.workGroupTickets.ticketId, tables.tickets.id))
    .where(eq(tables.workGroupTickets.workGroupId, workGroupId))
    .all();
}

export function getWorkGroupsForTicket(db: DB, ticketInternalId: number) {
  return db
    .select({
      groupId: tables.workGroups.groupId,
      title: tables.workGroups.title,
      status: tables.workGroups.status,
    })
    .from(tables.workGroupTickets)
    .innerJoin(tables.workGroups, eq(tables.workGroupTickets.workGroupId, tables.workGroups.id))
    .where(eq(tables.workGroupTickets.ticketId, ticketInternalId))
    .all();
}

export function listWorkGroups(
  db: DB,
  repoId: number,
  opts?: { status?: string; tag?: string },
) {
  const conditions = [eq(tables.workGroups.repoId, repoId)];
  if (opts?.status) {
    conditions.push(eq(tables.workGroups.status, opts.status));
  }

  const groups = db
    .select()
    .from(tables.workGroups)
    .where(and(...conditions))
    .all();

  if (opts?.tag) {
    return groups.filter((g) => {
      const tags = g.tagsJson ? JSON.parse(g.tagsJson) as string[] : [];
      return tags.includes(opts.tag!);
    });
  }

  return groups;
}

export function getWorkGroupProgress(db: DB, workGroupId: number) {
  const rows = db
    .select({
      status: tables.tickets.status,
      count: sql<number>`count(*)`,
    })
    .from(tables.workGroupTickets)
    .innerJoin(tables.tickets, eq(tables.workGroupTickets.ticketId, tables.tickets.id))
    .where(eq(tables.workGroupTickets.workGroupId, workGroupId))
    .groupBy(tables.tickets.status)
    .all();

  const byStatus: Record<string, number> = {};
  let total = 0;
  let completed = 0;
  const completedStatuses = new Set(["resolved", "closed", "wont_fix"]);

  for (const row of rows) {
    byStatus[row.status] = row.count;
    total += row.count;
    if (completedStatuses.has(row.status)) {
      completed += row.count;
    }
  }

  const blockers = db
    .select({ ticketId: tables.tickets.ticketId, title: tables.tickets.title })
    .from(tables.workGroupTickets)
    .innerJoin(tables.tickets, eq(tables.workGroupTickets.ticketId, tables.tickets.id))
    .where(
      and(
        eq(tables.workGroupTickets.workGroupId, workGroupId),
        eq(tables.tickets.status, "blocked"),
      ),
    )
    .all();

  return {
    totalTickets: total,
    byStatus,
    completionPercent: total > 0 ? Math.round((completed / total) * 100) : 0,
    blockers,
  };
}

// ─── Wave Queries ──────────────────────────────

export function getTicketWaveInfo(db: DB, workGroupId: number, ticketId: number) {
  const row = db
    .select({
      waveNumber: tables.workGroupTickets.waveNumber,
      waveStatus: tables.workGroupTickets.waveStatus,
    })
    .from(tables.workGroupTickets)
    .where(
      and(
        eq(tables.workGroupTickets.workGroupId, workGroupId),
        eq(tables.workGroupTickets.ticketId, ticketId),
      ),
    )
    .get();
  return row ?? undefined;
}

export function updateTicketWaveStatus(
  db: DB,
  workGroupId: number,
  ticketId: number,
  status: string,
) {
  return db
    .update(tables.workGroupTickets)
    .set({ waveStatus: status })
    .where(
      and(
        eq(tables.workGroupTickets.workGroupId, workGroupId),
        eq(tables.workGroupTickets.ticketId, ticketId),
      ),
    )
    .run();
}

export function setWaveAssignments(
  db: DB,
  workGroupId: number,
  assignments: Array<{ ticketId: number; waveNumber: number }>,
) {
  return db.transaction((tx) => {
    for (const { ticketId, waveNumber } of assignments) {
      tx.update(tables.workGroupTickets)
        .set({ waveNumber })
        .where(
          and(
            eq(tables.workGroupTickets.workGroupId, workGroupId),
            eq(tables.workGroupTickets.ticketId, ticketId),
          ),
        )
        .run();
    }
  });
}

export function getWaveTickets(db: DB, workGroupId: number, waveNumber: number) {
  return db
    .select({
      ticketId: tables.tickets.id,
      ticketPublicId: tables.tickets.ticketId,
      title: tables.tickets.title,
      status: tables.tickets.status,
      waveStatus: tables.workGroupTickets.waveStatus,
      affectedPathsJson: tables.tickets.affectedPathsJson,
    })
    .from(tables.workGroupTickets)
    .innerJoin(tables.tickets, eq(tables.workGroupTickets.ticketId, tables.tickets.id))
    .where(
      and(
        eq(tables.workGroupTickets.workGroupId, workGroupId),
        eq(tables.workGroupTickets.waveNumber, waveNumber),
      ),
    )
    .all();
}

export function isWaveComplete(db: DB, workGroupId: number, waveNumber: number): boolean {
  const total = db
    .select({ count: sql<number>`count(*)` })
    .from(tables.workGroupTickets)
    .where(
      and(
        eq(tables.workGroupTickets.workGroupId, workGroupId),
        eq(tables.workGroupTickets.waveNumber, waveNumber),
      ),
    )
    .get();

  if (!total || total.count === 0) return false;

  const notMerged = db
    .select({ count: sql<number>`count(*)` })
    .from(tables.workGroupTickets)
    .where(
      and(
        eq(tables.workGroupTickets.workGroupId, workGroupId),
        eq(tables.workGroupTickets.waveNumber, waveNumber),
        sql`${tables.workGroupTickets.waveStatus} != 'merged'`,
      ),
    )
    .get();

  return notMerged!.count === 0;
}

export function updateWorkGroupConvoy(
  db: DB,
  groupId: number,
  updates: {
    currentWave?: number;
    integrationBranch?: string;
    wavePlanJson?: string;
    launchedAt?: string;
    updatedAt: string;
  },
) {
  return db.update(tables.workGroups).set(updates).where(eq(tables.workGroups.id, groupId)).run();
}

export function getLaunchedWorkGroupsForTicket(db: DB, ticketInternalId: number) {
  return db
    .select({
      groupId: tables.workGroups.groupId,
      workGroupId: tables.workGroups.id,
      currentWave: tables.workGroups.currentWave,
      integrationBranch: tables.workGroups.integrationBranch,
      waveNumber: tables.workGroupTickets.waveNumber,
      waveStatus: tables.workGroupTickets.waveStatus,
    })
    .from(tables.workGroupTickets)
    .innerJoin(tables.workGroups, eq(tables.workGroupTickets.workGroupId, tables.workGroups.id))
    .where(
      and(
        eq(tables.workGroupTickets.ticketId, ticketInternalId),
        isNotNull(tables.workGroups.launchedAt),
      ),
    )
    .all();
}

// --- Auto-refresh queries ---

/** Find approved tickets in repo NOT already in the given work group. */
export function getApprovedTicketsNotInGroup(
  db: DB,
  repoId: number,
  workGroupId: number,
) {
  const inGroup = db
    .select({ ticketId: tables.workGroupTickets.ticketId })
    .from(tables.workGroupTickets)
    .where(eq(tables.workGroupTickets.workGroupId, workGroupId));

  return db
    .select({
      id: tables.tickets.id,
      ticketId: tables.tickets.ticketId,
      affectedPathsJson: tables.tickets.affectedPathsJson,
    })
    .from(tables.tickets)
    .where(
      and(
        eq(tables.tickets.repoId, repoId),
        eq(tables.tickets.status, "approved"),
        notInArray(tables.tickets.id, inGroup),
      ),
    )
    .all();
}

/** Bulk-add tickets to a work group with wave assignments in a transaction. */
export function appendWaveAssignments(
  db: DB,
  workGroupId: number,
  assignments: Array<{ ticketInternalId: number; waveNumber: number; addedAt: string }>,
) {
  return db.transaction((tx) => {
    for (const a of assignments) {
      tx.insert(tables.workGroupTickets)
        .values({
          workGroupId,
          ticketId: a.ticketInternalId,
          addedAt: a.addedAt,
          waveNumber: a.waveNumber,
          waveStatus: "pending",
        })
        .run();
    }
  });
}

/** Find all launched, open work groups in a repo. */
export function getLaunchedWorkGroupsInRepo(db: DB, repoId: number) {
  return db
    .select({
      id: tables.workGroups.id,
      groupId: tables.workGroups.groupId,
    })
    .from(tables.workGroups)
    .where(
      and(
        eq(tables.workGroups.repoId, repoId),
        eq(tables.workGroups.status, "open"),
        isNotNull(tables.workGroups.launchedAt),
      ),
    )
    .all();
}

/** Get wave slot info: ticket count and aggregate status per wave number. */
export function getWaveSlotInfo(db: DB, workGroupId: number) {
  return db
    .select({
      waveNumber: tables.workGroupTickets.waveNumber,
      ticketCount: sql<number>`count(*)`,
      allMerged: sql<number>`sum(case when ${tables.workGroupTickets.waveStatus} = 'merged' then 0 else 1 end) = 0`,
      anyDispatched: sql<number>`sum(case when ${tables.workGroupTickets.waveStatus} IN ('dispatched','merged','conflict','test_failed') then 1 else 0 end) > 0`,
    })
    .from(tables.workGroupTickets)
    .where(
      and(
        eq(tables.workGroupTickets.workGroupId, workGroupId),
        isNotNull(tables.workGroupTickets.waveNumber),
      ),
    )
    .groupBy(tables.workGroupTickets.waveNumber)
    .all();
}
