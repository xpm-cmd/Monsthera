import type { Database as DatabaseType } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { SearchBackendName } from "./interface.js";
import { FTS5Backend, sanitizeFts5Query } from "./fts5.js";
import { mergeResults, type SemanticReranker } from "./semantic.js";

export interface SearchDebugResultItem {
  path: string;
  score: number;
  source: "fts5" | "semantic" | "hybrid";
}

export interface CodeSearchDebugResult {
  query: string;
  sanitizedQuery: string;
  scope: string | null;
  limit: number;
  runtimeBackend: SearchBackendName;
  semanticAvailable: boolean;
  fts5Results: SearchDebugResultItem[];
  vectorResults: SearchDebugResultItem[];
  mergedResults: SearchDebugResultItem[];
}

export async function buildCodeSearchDebug(
  args: {
    sqlite: DatabaseType;
    db: BetterSQLite3Database<typeof schema>;
    repoId: number;
    runtimeBackend: SearchBackendName;
    semanticReranker: SemanticReranker | null;
  },
  params: {
    query: string;
    scope?: string;
    limit?: number;
  },
): Promise<CodeSearchDebugResult> {
  const limit = params.limit ?? 10;
  const scope = params.scope?.trim() ? params.scope.trim() : undefined;
  const sanitizedQuery = sanitizeFts5Query(params.query);
  const fts5 = new FTS5Backend(args.sqlite, args.db);
  const fts5Results = (await fts5.search(params.query, args.repoId, limit, scope))
    .map((result) => ({
      path: result.path,
      score: roundScore(result.score),
      source: "fts5" as const,
    }));

  const semanticAvailable = args.semanticReranker?.isAvailable() ?? false;
  const vectorBase = semanticAvailable
    ? await args.semanticReranker!.vectorSearch(params.query, args.repoId, limit, scope)
    : [];
  const vectorResults = vectorBase.map((result) => ({
    path: result.path,
    score: roundScore(result.score),
    source: "semantic" as const,
  }));

  const mergedBase = semanticAvailable
    ? mergeResults(
      fts5Results.map(({ path, score }) => ({ path, score })),
      vectorResults.map(({ path, score }) => ({ path, score })),
      limit,
      0.5,
      !!scope,
    )
    : fts5Results.map(({ path, score }) => ({ path, score }));

  const mergedSet = new Set(fts5Results.map((result) => result.path));
  const vectorSet = new Set(vectorResults.map((result) => result.path));

  return {
    query: params.query,
    sanitizedQuery,
    scope: scope ?? null,
    limit,
    runtimeBackend: args.runtimeBackend,
    semanticAvailable,
    fts5Results,
    vectorResults,
    mergedResults: mergedBase.map((result) => ({
      path: result.path,
      score: roundScore(result.score),
      source: mergedSet.has(result.path) && vectorSet.has(result.path)
        ? "hybrid"
        : mergedSet.has(result.path)
          ? "fts5"
          : "semantic",
    })),
  };
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}
