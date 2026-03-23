import type { Database as DatabaseType } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { parseStringArrayJson } from "../core/input-hardening.js";
import * as queries from "../db/queries.js";
import type { SearchRouter } from "../search/router.js";
import { blendScores } from "../search/semantic.js";

type DB = BetterSQLite3Database<typeof schema>;

export type KnowledgeScope = "repo" | "global" | "all";

export interface SearchKnowledgeOptions {
  query: string;
  scope?: KnowledgeScope;
  type?: string;
  limit?: number;
}

export interface SearchKnowledgeDeps {
  db: DB;
  sqlite: DatabaseType;
  globalDb: DB | null;
  globalSqlite: DatabaseType | null;
  searchRouter: SearchRouter;
}

export interface KnowledgeSearchEntry {
  key: string;
  type: string;
  scope: "repo" | "global";
  title: string;
  content: string;
  tags: string[];
  status: string;
  agentId: string | null;
  updatedAt: string;
  score: number;
}

export interface KnowledgeSearchInitializer {
  initKnowledgeFts(sqlite: DatabaseType): void;
  isKnowledgeIndexCurrent(sqlite: DatabaseType): boolean;
  rebuildKnowledgeFts(sqlite: DatabaseType): void;
}

export interface KnowledgeSearchPayload {
  query: string;
  scope: KnowledgeScope;
  count: number;
  results: Array<{
    key: string;
    type: string;
    scope: "repo" | "global";
    title: string;
    content: string;
    tags: string[];
    score: number;
  }>;
}

export interface KnowledgeSearchBriefPayload {
  query: string;
  scope: KnowledgeScope;
  count: number;
  results: Array<{
    key: string;
    type: string;
    scope: "repo" | "global";
    title: string;
    score: number;
  }>;
}

export function buildKnowledgeSearchBriefPayload(
  query: string,
  scope: KnowledgeScope,
  results: KnowledgeSearchEntry[],
): KnowledgeSearchBriefPayload {
  return {
    query,
    scope,
    count: results.length,
    results: results.map((entry) => ({
      key: entry.key,
      type: entry.type,
      scope: entry.scope,
      title: entry.title,
      score: Math.round(entry.score * 1000) / 1000,
    })),
  };
}

export function prepareKnowledgeSearchTarget(
  initializer: KnowledgeSearchInitializer,
  sqlite: DatabaseType,
): void {
  initializer.initKnowledgeFts(sqlite);
  if (!initializer.isKnowledgeIndexCurrent(sqlite)) {
    initializer.rebuildKnowledgeFts(sqlite);
  }
}

export async function searchKnowledgeEntries(
  deps: SearchKnowledgeDeps,
  opts: SearchKnowledgeOptions,
): Promise<KnowledgeSearchEntry[]> {
  const query = opts.query.trim();
  if (!query) return [];

  const scope = opts.scope ?? "all";
  const limit = opts.limit ?? 10;

  type ScopedDb = {
    db: DB;
    sqlite: DatabaseType;
    scopeLabel: "repo" | "global";
  };

  const targets: ScopedDb[] = [];
  if (scope === "repo" || scope === "all") {
    targets.push({ db: deps.db, sqlite: deps.sqlite, scopeLabel: "repo" });
  }
  if ((scope === "global" || scope === "all") && deps.globalDb && deps.globalSqlite) {
    targets.push({ db: deps.globalDb, sqlite: deps.globalSqlite, scopeLabel: "global" });
  }

  const results: KnowledgeSearchEntry[] = [];

  for (const target of targets) {
    const ftsResults = deps.searchRouter.searchKnowledge(target.sqlite, query, limit, opts.type);
    // Batch-load knowledge entries to avoid N+1 queries
    const ids = ftsResults.map((r) => r.knowledgeId);
    const entries = queries.getKnowledgeByIds(target.db, ids);
    const entryMap = new Map(entries.map((e) => [e.id, e]));
    for (const result of ftsResults) {
      const entry = entryMap.get(result.knowledgeId);
      if (!entry?.content) continue;
      results.push({
        key: entry.key,
        type: entry.type,
        scope: target.scopeLabel,
        title: entry.title,
        content: entry.content,
        tags: parseStringArrayJson(entry.tagsJson, {
          maxItems: 25,
          maxItemLength: 64,
        }),
        status: entry.status,
        agentId: entry.agentId ?? null,
        updatedAt: entry.updatedAt,
        score: result.score,
      });
    }
  }

  const reranker = deps.searchRouter.getSemanticReranker();
  if (reranker?.isAvailable()) {
    const queryEmbedding = await reranker.embed(query);
    if (queryEmbedding) {
      const makeResultKey = (scopeLabel: string, key: string) => `${scopeLabel}:${key}`;
      const maxFtsScore = results.length
        ? Math.max(...results.map((entry) => entry.score), 1)
        : 1;
      const semanticBlendAlpha = deps.searchRouter.getSearchConfig().semanticBlendAlpha;
      const scoresByKey = new Map(results.map((entry) => [makeResultKey(entry.scope, entry.key), entry.score]));
      const seenKeys = new Set(results.map((entry) => makeResultKey(entry.scope, entry.key)));

      for (const target of targets) {
        const knowledgeVectorMinScore = deps.searchRouter.getSearchConfig().thresholds.knowledgeVectorMinScore;
        const vectorResults = reranker.searchKnowledgeByVector(target.sqlite, queryEmbedding, limit * 3);
        // Batch-load full entries for vector results
        const vectorIds = vectorResults
          .filter((e) => (!opts.type || e.type === opts.type) && e.score >= knowledgeVectorMinScore)
          .map((e) => e.id);
        const fullEntries = queries.getKnowledgeByIds(target.db, vectorIds);
        const fullEntryMap = new Map(fullEntries.map((e) => [e.id, e]));
        for (const entry of vectorResults) {
          if (opts.type && entry.type !== opts.type) continue;
          if (entry.score < knowledgeVectorMinScore) continue;

          const fullEntry = fullEntryMap.get(entry.id);
          if (!fullEntry?.content) continue;

          const resultKey = makeResultKey(target.scopeLabel, entry.key);
          const mergedScore = scoresByKey.has(resultKey)
            ? blendScores((scoresByKey.get(resultKey) ?? 0) / maxFtsScore, entry.score, semanticBlendAlpha)
            : entry.score;

          if (!seenKeys.has(resultKey)) {
            seenKeys.add(resultKey);
            results.push({
              key: fullEntry.key,
              type: fullEntry.type,
              scope: target.scopeLabel,
              title: fullEntry.title,
              content: fullEntry.content,
              tags: parseStringArrayJson(fullEntry.tagsJson, {
                maxItems: 25,
                maxItemLength: 64,
              }),
              status: fullEntry.status,
              agentId: fullEntry.agentId ?? null,
              updatedAt: fullEntry.updatedAt,
              score: mergedScore,
            });
            continue;
          }

          const existing = results.find((candidate) => makeResultKey(candidate.scope, candidate.key) === resultKey);
          if (existing) {
            existing.score = mergedScore;
          }
        }
      }
    }
  }

  results.sort((left, right) => right.score - left.score);
  return results.slice(0, limit);
}

export function buildKnowledgeSearchPayload(
  query: string,
  scope: KnowledgeScope,
  results: KnowledgeSearchEntry[],
): KnowledgeSearchPayload {
  return {
    query,
    scope,
    count: results.length,
    results: results.map((entry) => ({
      key: entry.key,
      type: entry.type,
      scope: entry.scope,
      title: entry.title,
      content: entry.content.slice(0, 500) + (entry.content.length > 500 ? "..." : ""),
      tags: entry.tags,
      score: Math.round(entry.score * 1000) / 1000,
    })),
  };
}
