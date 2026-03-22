import { posix as pathPosix } from "node:path";
import { eq, and, like, sql, inArray, type DB, tables, escapeLike } from "./common.js";

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

export type ImportGraphNode = {
  id: number;
  path: string;
  language: string | null;
};

export type ImportGraphEdge = {
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
  const scope = opts?.scope?.trim();
  const focusPath = opts?.focusFilePath?.trim();

  // When scope is provided and no focus path, filter at SQL level to avoid loading entire table
  const fileConditions = [eq(tables.files.repoId, repoId)];
  if (scope && !focusPath) {
    fileConditions.push(sql`${tables.files.path} LIKE ${scope + "%"}`);
  }

  const allFiles = db.select({
    id: tables.files.id,
    path: tables.files.path,
    language: tables.files.language,
  }).from(tables.files).where(and(...fileConditions)).all();

  if (allFiles.length === 0) {
    return { files: [] as ImportGraphNode[], edges: [] as ImportGraphEdge[] };
  }

  const pathToNode = new Map(allFiles.map((file) => [file.path, file] as const));
  const allPaths = new Set(pathToNode.keys());

  // For scoped queries without focus, only load imports where source is in scope
  const importConditions = [eq(tables.files.repoId, repoId)];
  if (scope && !focusPath) {
    importConditions.push(sql`${tables.files.path} LIKE ${scope + "%"}`);
  }

  const allImports = db.select({
    sourceFileId: tables.imports.sourceFileId,
    targetPath: tables.imports.targetPath,
    kind: tables.imports.kind,
    sourcePath: tables.files.path,
  }).from(tables.imports)
    .innerJoin(tables.files, eq(tables.imports.sourceFileId, tables.files.id))
    .where(and(...importConditions))
    .all();

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

  return buildImportGraphSubset(allImports, pathToNode, allPaths, allPaths);
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
