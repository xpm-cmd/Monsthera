import { eq, and, like, desc, or, sql, notInArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { posix as pathPosix } from "node:path";
import { parseStringArrayJson } from "../core/input-hardening.js";
import type * as schema from "./schema.js";
import * as tables from "./schema.js";

type DB = BetterSQLite3Database<typeof schema>;
type QueryDb = Pick<DB, "select" | "insert" | "update" | "delete">;

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

type ImportGraphNode = {
  id: number;
  path: string;
  language: string | null;
};

type ImportGraphEdge = {
  source: number;
  target: number;
  kind: string;
};

const RESOLVABLE_IMPORT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs"] as const;

export function getImportGraph(
  db: DB,
  repoId: number,
  opts?: { scope?: string; focusFilePath?: string },
) {
  const allFiles = db.select({
    id: tables.files.id,
    path: tables.files.path,
    language: tables.files.language,
  }).from(tables.files).where(eq(tables.files.repoId, repoId)).all();

  const pathToNode = new Map(allFiles.map((file) => [file.path, file] as const));
  const allPaths = new Set(pathToNode.keys());
  const allImports = db.select({
    sourceFileId: tables.imports.sourceFileId,
    targetPath: tables.imports.targetPath,
    kind: tables.imports.kind,
    sourcePath: tables.files.path,
  }).from(tables.imports)
    .innerJoin(tables.files, eq(tables.imports.sourceFileId, tables.files.id))
    .where(eq(tables.files.repoId, repoId))
    .all();

  if (allFiles.length === 0) {
    return { files: [] as ImportGraphNode[], edges: [] as ImportGraphEdge[] };
  }

  const focusPath = opts?.focusFilePath?.trim();
  if (focusPath && pathToNode.has(focusPath)) {
    const nodePaths = new Set<string>([focusPath]);

    for (const imp of allImports) {
      if (imp.sourcePath === focusPath) {
        const resolved = resolveIndexedImportTarget(imp.sourcePath, imp.targetPath, allPaths);
        if (resolved) nodePaths.add(resolved);
      }
    }

    for (const imp of allImports) {
      const resolved = resolveIndexedImportTarget(imp.sourcePath, imp.targetPath, allPaths);
      if (resolved === focusPath) nodePaths.add(imp.sourcePath);
    }

    return buildImportGraphSubset(allImports, pathToNode, allPaths, nodePaths);
  }

  const scope = opts?.scope?.trim();
  const scopedPaths = scope
    ? new Set(allFiles.filter((file) => file.path.startsWith(scope)).map((file) => file.path))
    : new Set(allPaths);

  return buildImportGraphSubset(allImports, pathToNode, allPaths, scopedPaths);
}

function buildImportGraphSubset(
  allImports: Array<{ sourceFileId: number; targetPath: string; kind: string; sourcePath: string }>,
  pathToNode: Map<string, ImportGraphNode>,
  allPaths: Set<string>,
  allowedPaths: Set<string>,
) {
  const files = Array.from(allowedPaths)
    .map((path) => pathToNode.get(path))
    .filter((file): file is ImportGraphNode => Boolean(file))
    .sort((a, b) => a.path.localeCompare(b.path));
  const pathToId = new Map(files.map((file) => [file.path, file.id] as const));
  const edges: ImportGraphEdge[] = [];

  for (const imp of allImports) {
    if (!allowedPaths.has(imp.sourcePath)) continue;
    const resolvedTarget = resolveIndexedImportTarget(imp.sourcePath, imp.targetPath, allPaths);
    if (!resolvedTarget || !allowedPaths.has(resolvedTarget)) continue;
    const sourceId = pathToId.get(imp.sourcePath);
    const targetId = pathToId.get(resolvedTarget);
    if (sourceId !== undefined && targetId !== undefined) {
      edges.push({ source: sourceId, target: targetId, kind: imp.kind });
    }
  }

  return { files, edges };
}

function resolveIndexedImportTarget(
  sourcePath: string,
  importPath: string,
  indexedPaths: Set<string>,
): string | null {
  if (!importPath) return null;
  if (indexedPaths.has(importPath)) return importPath;

  const candidates = new Set<string>();
  const addCandidates = (basePath: string) => {
    const normalized = pathPosix.normalize(basePath).replace(/^\.\/+/, "");
    // Invariant: resolved import targets must stay inside the repo-relative namespace.
    // If normalization still contains parent traversal, reject the candidate entirely.
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
      return;
    }
    candidates.add(normalized);

    const ext = pathPosix.extname(normalized);
    const withoutExt = ext ? normalized.slice(0, -ext.length) : normalized;
    if (ext) {
      for (const candidateExt of RESOLVABLE_IMPORT_EXTENSIONS) {
        candidates.add(`${withoutExt}${candidateExt}`);
        candidates.add(pathPosix.join(withoutExt, `index${candidateExt}`));
      }
    } else {
      for (const candidateExt of RESOLVABLE_IMPORT_EXTENSIONS) {
        candidates.add(`${normalized}${candidateExt}`);
        candidates.add(pathPosix.join(normalized, `index${candidateExt}`));
      }
    }
  };

  if (importPath.startsWith(".")) {
    addCandidates(pathPosix.join(pathPosix.dirname(sourcePath), importPath));
  } else if (importPath.startsWith("/")) {
    addCandidates(importPath.slice(1));
  } else {
    addCandidates(importPath);
  }

  for (const candidate of candidates) {
    if (indexedPaths.has(candidate)) return candidate;
  }

  return null;
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
  const identityFields = {
    provider: agent.provider ?? null,
    model: agent.model ?? null,
    modelFamily: agent.modelFamily ?? null,
    modelVersion: agent.modelVersion ?? null,
    identitySource: agent.identitySource ?? null,
  };
  if (existing) {
    db.update(tables.agents)
      .set({
        name: agent.name,
        type: agent.type,
        ...identityFields,
        roleId: agent.roleId,
        trustTier: agent.trustTier,
      })
      .where(eq(tables.agents.id, agent.id))
      .run();
    return db.select().from(tables.agents).where(eq(tables.agents.id, agent.id)).get();
  }
  return db.insert(tables.agents).values({
    ...agent,
    ...identityFields,
  }).returning().get();
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

// --- Knowledge ---

export function upsertKnowledge(
  db: QueryDb,
  entry: typeof tables.knowledge.$inferInsert,
): typeof tables.knowledge.$inferSelect {
  const existing = db.select().from(tables.knowledge).where(eq(tables.knowledge.key, entry.key)).get();
  if (existing) {
    // Re-resolve/close updates the distilled content, but preserves the original actor/session attribution.
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
      const entryTags = parseStringArrayJson(r.tagsJson, {
        maxItems: 25,
        maxItemLength: 64,
      });
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
      const ticketTags = parseStringArrayJson(ticket.tagsJson, {
        maxItems: 25,
        maxItemLength: 64,
      });
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
  const existing = db
    .select()
    .from(tables.councilAssignments)
    .where(and(
      eq(tables.councilAssignments.ticketId, assignment.ticketId),
      eq(tables.councilAssignments.specialization, assignment.specialization),
    ))
    .get();

  if (!existing) {
    return db.insert(tables.councilAssignments).values(assignment).returning().get();
  }

  return db
    .update(tables.councilAssignments)
    .set({
      agentId: assignment.agentId,
      assignedByAgentId: assignment.assignedByAgentId,
      assignedAt: assignment.assignedAt,
    })
    .where(eq(tables.councilAssignments.id, existing.id))
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

export function upsertReviewVerdict(
  db: DB,
  verdict: typeof tables.reviewVerdicts.$inferInsert,
): typeof tables.reviewVerdicts.$inferSelect {
  const existing = db
    .select()
    .from(tables.reviewVerdicts)
    .where(and(
      eq(tables.reviewVerdicts.ticketId, verdict.ticketId),
      eq(tables.reviewVerdicts.specialization, verdict.specialization),
    ))
    .get();

  if (!existing) {
    return db.insert(tables.reviewVerdicts).values(verdict).returning().get();
  }

  return db
    .update(tables.reviewVerdicts)
    .set({
      agentId: verdict.agentId,
      sessionId: verdict.sessionId,
      verdict: verdict.verdict,
      reasoning: verdict.reasoning ?? null,
      createdAt: verdict.createdAt,
    })
    .where(eq(tables.reviewVerdicts.id, existing.id))
    .returning()
    .get();
}

export function getReviewVerdicts(db: DB, ticketInternalId: number) {
  try {
    return db
      .select()
      .from(tables.reviewVerdicts)
      .where(eq(tables.reviewVerdicts.ticketId, ticketInternalId))
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
    dependencyCount: 0,
    latestDependencyAt: null,
    linkedPatchCount: 0,
    latestLinkedPatchAt: null,
  });
}

// --- Protected Artifacts ---

export function insertProtectedArtifact(
  db: DB,
  data: { repoId: number; pathPattern: string; reason: string; createdBy: string; createdAt: string },
) {
  return db
    .insert(tables.protectedArtifacts)
    .values(data)
    .returning()
    .get();
}

export function getProtectedArtifacts(db: DB, repoId: number) {
  try {
    return db
      .select()
      .from(tables.protectedArtifacts)
      .where(eq(tables.protectedArtifacts.repoId, repoId))
      .all();
  } catch (error) {
    if (isMissingTableError(error, "protected_artifacts")) return [];
    throw error;
  }
}

export function getProtectedArtifactByPattern(db: DB, repoId: number, pathPattern: string) {
  return db
    .select()
    .from(tables.protectedArtifacts)
    .where(and(eq(tables.protectedArtifacts.repoId, repoId), eq(tables.protectedArtifacts.pathPattern, pathPattern)))
    .get();
}

export function deleteProtectedArtifact(db: DB, repoId: number, pathPattern: string) {
  return db
    .delete(tables.protectedArtifacts)
    .where(and(eq(tables.protectedArtifacts.repoId, repoId), eq(tables.protectedArtifacts.pathPattern, pathPattern)))
    .run();
}

function isMissingTableError(error: unknown, tableName: string): boolean {
  return error instanceof Error && error.message.includes(`no such table: ${tableName}`);
}
