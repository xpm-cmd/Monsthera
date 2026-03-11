import type { Database as DatabaseType } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { SearchBackendName, SearchResult } from "./interface.js";
import { sanitizeFts5Query } from "./fts5.js";
import { mergeResults, type SemanticReranker } from "./semantic.js";
import { DEFAULT_SEMANTIC_BLEND_ALPHA } from "./constants.js";

export interface SearchDebugResultItem {
  path: string;
  score: number;
  source: "fts5" | "zoekt" | "semantic" | "hybrid";
}

export interface CodeSearchDebugResult {
  query: string;
  sanitizedQuery: string | null;
  scope: string | null;
  limit: number;
  runtimeBackend: SearchBackendName;
  lexicalBackend: "fts5" | "zoekt";
  semanticAvailable: boolean;
  lexicalResults: SearchDebugResultItem[];
  vectorResults: SearchDebugResultItem[];
  mergedResults: SearchDebugResultItem[];
}

export async function buildCodeSearchDebug(
  args: {
    sqlite: DatabaseType;
    db: BetterSQLite3Database<typeof schema>;
    repoId: number;
    runtimeBackend: SearchBackendName;
    lexicalBackend: "fts5" | "zoekt";
    lexicalSearch: (query: string, repoId: number, limit?: number, scope?: string) => Promise<SearchResult[]>;
    semanticReranker: SemanticReranker | null;
    semanticBlendAlpha?: number;
    andQueryTermCount?: number;
  },
  params: {
    query: string;
    scope?: string;
    limit?: number;
  },
): Promise<CodeSearchDebugResult> {
  const limit = params.limit ?? 10;
  const scope = params.scope?.trim() ? params.scope.trim() : undefined;
  const sanitizedQuery = args.lexicalBackend === "fts5"
    ? sanitizeFts5Query(params.query, args.andQueryTermCount)
    : null;
  const lexicalResults = (await args.lexicalSearch(params.query, args.repoId, limit, scope))
    .map((result) => ({
      path: result.path,
      score: roundScore(result.score),
      source: args.lexicalBackend,
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
      lexicalResults.map(({ path, score }) => ({ path, score })),
      vectorResults.map(({ path, score }) => ({ path, score })),
      limit,
      args.semanticBlendAlpha ?? DEFAULT_SEMANTIC_BLEND_ALPHA,
      !!scope,
    )
    : lexicalResults.map(({ path, score }) => ({ path, score }));

  const mergedSet = new Set(lexicalResults.map((result) => result.path));
  const vectorSet = new Set(vectorResults.map((result) => result.path));

  return {
    query: params.query,
    sanitizedQuery,
    scope: scope ?? null,
    limit,
    runtimeBackend: args.runtimeBackend,
    lexicalBackend: args.lexicalBackend,
    semanticAvailable,
    lexicalResults,
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
