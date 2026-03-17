import { eq, and, like, desc, or, sql, notInArray, isNull, isNotNull, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { posix as pathPosix } from "node:path";
import { parseStringArrayJson } from "../core/input-hardening.js";
import type * as schema from "./schema.js";
import * as tables from "./schema.js";

type DB = BetterSQLite3Database<typeof schema>;
type QueryDb = Pick<DB, "select" | "insert" | "update" | "delete">;

function escapeLike(s: string): string {
  return s.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

const TICKET_RESOLUTION_COMMITS_COLUMN = "resolution_commits_json";
const ticketResolutionCommitsColumnCache = new WeakMap<object, boolean>();
const REVIEW_VERDICT_PENDING_REPLACEMENT = -1;
export const REVIEW_VERDICT_CLEARED_ON_RESET = 0;

// --- Repos ---

export function upsertRepo(db: DB, path: string, name: string): { id: number } {
  return db
    .insert(tables.repos)
    .values({ path, name, createdAt: new Date().toISOString() })
    .onConflictDoUpdate({ target: tables.repos.path, set: { name } })
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

export function getFilesByPaths(db: DB, repoId: number, paths: string[]) {
  if (paths.length === 0) return [];
  return db
    .select()
    .from(tables.files)
    .where(and(eq(tables.files.repoId, repoId), inArray(tables.files.path, paths)))
    .all();
}

export function searchFilesByPath(db: DB, repoId: number, pattern: string) {
  return db
    .select()
    .from(tables.files)
    .where(and(eq(tables.files.repoId, repoId), like(tables.files.path, `%${escapeLike(pattern)}%`)))
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
    .where(like(tables.imports.targetPath, `%${escapeLike(targetPath)}%`))
    .all();
}

// --- Symbol References ---

export function getReferencesTo(
  db: DB,
  repoId: number,
  targetName: string,
  kind?: "call" | "member_call" | "type_ref",
  limit?: number,
) {
  const conditions = [
    eq(tables.files.repoId, repoId),
    eq(tables.symbolReferences.targetName, targetName),
  ];
  if (kind) {
    conditions.push(eq(tables.symbolReferences.referenceKind, kind));
  }
  const q = db
    .select()
    .from(tables.symbolReferences)
    .innerJoin(tables.files, eq(tables.symbolReferences.sourceFileId, tables.files.id))
    .where(and(...conditions));
  return limit ? q.limit(limit).all() : q.all();
}

export function getReferencesFrom(
  db: DB,
  repoId: number,
  sourceSymbolName: string,
  kind?: "call" | "member_call" | "type_ref",
  limit?: number,
) {
  const conditions = [
    eq(tables.files.repoId, repoId),
    eq(tables.symbolReferences.sourceSymbolName, sourceSymbolName),
  ];
  if (kind) {
    conditions.push(eq(tables.symbolReferences.referenceKind, kind));
  }
  const q = db
    .select()
    .from(tables.symbolReferences)
    .innerJoin(tables.files, eq(tables.symbolReferences.sourceFileId, tables.files.id))
    .where(and(...conditions));
  return limit ? q.limit(limit).all() : q.all();
}

export function getReferencesForFile(db: DB, fileId: number) {
  return db.select().from(tables.symbolReferences).where(eq(tables.symbolReferences.sourceFileId, fileId)).all();
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

// --- Transitive dependency tracing ---

export interface TransitiveDep {
  path: string;
  depth: number;
  isCycle: boolean;
}

export function traceTransitiveDeps(
  db: DB,
  repoId: number,
  filePath: string,
  opts: { direction: "inbound" | "outbound" | "both"; maxDepth?: number },
): TransitiveDep[] {
  const maxDepth = Math.min(opts.maxDepth ?? 3, 5);

  // Load all files and imports for this repo into memory
  const allFiles = db.select({ id: tables.files.id, path: tables.files.path })
    .from(tables.files).where(eq(tables.files.repoId, repoId)).all();
  const allPaths = new Set(allFiles.map(f => f.path));

  const allImports = db.select({
    sourceFileId: tables.imports.sourceFileId,
    targetPath: tables.imports.targetPath,
    sourcePath: tables.files.path,
  }).from(tables.imports)
    .innerJoin(tables.files, eq(tables.imports.sourceFileId, tables.files.id))
    .where(eq(tables.files.repoId, repoId))
    .all();

  // Build adjacency lists
  // outbound: file -> [files it imports]
  // inbound: file -> [files that import it]
  const outbound = new Map<string, Set<string>>();
  const inbound = new Map<string, Set<string>>();

  for (const imp of allImports) {
    const resolved = resolveIndexedImportTarget(imp.sourcePath, imp.targetPath, allPaths);
    if (!resolved) continue;

    if (!outbound.has(imp.sourcePath)) outbound.set(imp.sourcePath, new Set());
    outbound.get(imp.sourcePath)!.add(resolved);

    if (!inbound.has(resolved)) inbound.set(resolved, new Set());
    inbound.get(resolved)!.add(imp.sourcePath);
  }

  // BFS
  const results: TransitiveDep[] = [];
  const visited = new Set<string>([filePath]);
  const queue: Array<{ path: string; depth: number }> = [{ path: filePath, depth: 0 }];

  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;

    const neighbors = new Set<string>();
    if (opts.direction === "outbound" || opts.direction === "both") {
      for (const n of outbound.get(path) ?? []) neighbors.add(n);
    }
    if (opts.direction === "inbound" || opts.direction === "both") {
      for (const n of inbound.get(path) ?? []) neighbors.add(n);
    }

    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) {
        results.push({ path: neighbor, depth: depth + 1, isCycle: true });
        continue;
      }
      visited.add(neighbor);
      results.push({ path: neighbor, depth: depth + 1, isCycle: false });
      queue.push({ path: neighbor, depth: depth + 1 });
    }
  }

  return results;
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
  const identityFields = {
    provider: agent.provider ?? null,
    model: agent.model ?? null,
    modelFamily: agent.modelFamily ?? null,
    modelVersion: agent.modelVersion ?? null,
    identitySource: agent.identitySource ?? null,
  };
  return db.insert(tables.agents).values({
    ...agent,
    ...identityFields,
  }).onConflictDoUpdate({
    target: tables.agents.id,
    set: {
      name: agent.name,
      type: agent.type,
      ...identityFields,
      roleId: agent.roleId,
      trustTier: agent.trustTier,
    },
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

// --- Session Worktree ---

export function updateSessionWorktree(
  db: DB, sessionId: string, worktreePath: string, worktreeBranch: string,
) {
  return db.update(tables.sessions)
    .set({ worktreePath, worktreeBranch })
    .where(eq(tables.sessions.id, sessionId))
    .run();
}

export function getSessionWorktree(db: DB, sessionId: string) {
  const session = db.select({
    worktreePath: tables.sessions.worktreePath,
    worktreeBranch: tables.sessions.worktreeBranch,
  }).from(tables.sessions)
    .where(eq(tables.sessions.id, sessionId))
    .get();
  if (!session?.worktreePath || !session?.worktreeBranch) return null;
  return { worktreePath: session.worktreePath, worktreeBranch: session.worktreeBranch };
}

// --- Atomic Claims ---

export interface AtomicClaimResult {
  ok: boolean;
  conflicts: Array<{ path: string; claimedBy: string; existingClaim: string }>;
}

export function claimFilesAtomic(
  db: DB,
  sessionId: string,
  paths: string[],
  enforceMode: "advisory" | "strict",
  heartbeatCutoff: string,
  overlapFn: (a: string, b: string) => boolean,
): AtomicClaimResult {
  return db.transaction((tx) => {
    // 1. Read all live sessions' claims
    const liveSessions = tx.select().from(tables.sessions)
      .where(and(
        eq(tables.sessions.state, "active"),
        sql`${tables.sessions.lastActivity} >= ${heartbeatCutoff}`,
      ))
      .all();

    // 2. Check for conflicts
    const conflicts: AtomicClaimResult["conflicts"] = [];
    for (const session of liveSessions) {
      if (session.id === sessionId) continue;
      let claimed: string[];
      try {
        claimed = JSON.parse(session.claimedFilesJson || "[]") as string[];
        if (!Array.isArray(claimed)) claimed = [];
      } catch {
        claimed = [];
      }
      for (const requestedPath of paths) {
        const conflictClaim = claimed.find((existing) => overlapFn(existing, requestedPath));
        if (conflictClaim) {
          conflicts.push({
            path: requestedPath,
            claimedBy: session.agentId,
            existingClaim: conflictClaim,
          });
        }
      }
    }

    // 3. In strict mode with conflicts, abort
    if (enforceMode === "strict" && conflicts.length > 0) {
      return { ok: false, conflicts };
    }

    // 4. Write claims atomically
    tx.update(tables.sessions)
      .set({ claimedFilesJson: JSON.stringify(paths) })
      .where(eq(tables.sessions.id, sessionId))
      .run();

    return { ok: true, conflicts };
  });
}

// --- Commit Locks ---

/** Max time a commit lock can be held before auto-expiry (5 minutes). */
const COMMIT_LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Attempt to acquire the global commit lock.
 * Returns true if acquired, false if already held.
 * Auto-expires stale locks older than COMMIT_LOCK_TTL_MS.
 * Uses SQLite transaction for atomicity.
 */
export function acquireCommitLock(
  db: DB, sessionId: string, agentId: string, ticketId?: string,
): boolean {
  return db.transaction((tx) => {
    const existing = tx.select().from(tables.commitLocks)
      .where(sql`${tables.commitLocks.releasedAt} IS NULL`)
      .get();

    if (existing) {
      // Auto-expire stale locks from crashed sessions
      const acquiredAt = new Date(existing.acquiredAt).getTime();
      const age = Date.now() - acquiredAt;
      if (age > COMMIT_LOCK_TTL_MS) {
        tx.update(tables.commitLocks)
          .set({ releasedAt: new Date().toISOString() })
          .where(eq(tables.commitLocks.id, existing.id))
          .run();
        // Fall through to acquire new lock
      } else {
        return false;
      }
    }

    tx.insert(tables.commitLocks).values({
      sessionId, agentId, ticketId: ticketId ?? null,
      acquiredAt: new Date().toISOString(),
    }).run();
    return true;
  });
}

export function releaseCommitLock(db: DB, sessionId: string): void {
  db.update(tables.commitLocks)
    .set({ releasedAt: new Date().toISOString() })
    .where(and(
      eq(tables.commitLocks.sessionId, sessionId),
      sql`${tables.commitLocks.releasedAt} IS NULL`,
    ))
    .run();
}

export function getActiveCommitLock(db: DB) {
  return db.select().from(tables.commitLocks)
    .where(sql`${tables.commitLocks.releasedAt} IS NULL`)
    .get() ?? null;
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
      reasoning: r.reasoning ? (r.reasoning.length > 200 ? r.reasoning.slice(0, 200) + "…" : r.reasoning) : "",
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
    verdictCount: sql<number>`(
      select count(*)
      from review_verdicts v
      inner join tickets t on t.id = v.ticket_id
      where t.repo_id = ${repoId}
    )`,
    latestVerdictAt: sql<string | null>`(
      select max(v.created_at)
      from review_verdicts v
      inner join tickets t on t.id = v.ticket_id
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
    verdictCount: 0,
    latestVerdictAt: null,
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

// --- Job Slots ---

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

function isMissingTableError(error: unknown, tableName: string): boolean {
  return error instanceof Error && error.message.includes(`no such table: ${tableName}`);
}

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

// --- Work Groups ---

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
