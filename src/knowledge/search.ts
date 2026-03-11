import type { Database as DatabaseType } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { parseStringArrayJson } from "../core/input-hardening.js";
import * as queries from "../db/queries.js";
import type { SearchRouter } from "../search/router.js";
import { blendScores, DEFAULT_SEMANTIC_BLEND_ALPHA } from "../search/semantic.js";

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
    for (const result of ftsResults) {
      const entry = queries.getKnowledgeById(target.db, result.knowledgeId);
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
      const scoresByKey = new Map(results.map((entry) => [makeResultKey(entry.scope, entry.key), entry.score]));
      const seenKeys = new Set(results.map((entry) => makeResultKey(entry.scope, entry.key)));

      for (const target of targets) {
        const vectorResults = reranker.searchKnowledgeByVector(target.sqlite, queryEmbedding, limit * 3);
        for (const entry of vectorResults) {
          if (opts.type && entry.type !== opts.type) continue;
          if (entry.score < 0.6) continue;

          const fullEntry = queries.getKnowledgeById(target.db, entry.id);
          if (!fullEntry?.content) continue;

          const resultKey = makeResultKey(target.scopeLabel, entry.key);
          const mergedScore = scoresByKey.has(resultKey)
            ? blendScores((scoresByKey.get(resultKey) ?? 0) / maxFtsScore, entry.score, DEFAULT_SEMANTIC_BLEND_ALPHA)
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
