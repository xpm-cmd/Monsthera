import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { parseStringArrayJson } from "../core/input-hardening.js";
import * as queries from "../db/queries.js";
import type * as schema from "../db/schema.js";

type DB = BetterSQLite3Database<typeof schema>;
type KnowledgeScope = "repo" | "global" | "all";

export interface KnowledgeFilters {
  scope?: KnowledgeScope;
  type?: string;
  tags?: string[];
  status?: string;
  limit?: number;
}

export interface KnowledgeListPayload {
  count: number;
  entries: Array<{
    key: string;
    type: string;
    scope: string;
    title: string;
    tags: string[];
    status: string;
    updatedAt: string;
  }>;
}

export interface KnowledgeDetailPayload {
  key: string;
  type: string;
  scope: string;
  title: string;
  content: string;
  tags: string[];
  status: string;
  agentId: string | null;
  sessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeSummaryPayload {
  totalCount: number;
  scopeCounts: Record<string, number>;
  typeCounts: Record<string, number>;
  statusCounts: Record<string, number>;
  recent: KnowledgeListPayload["entries"];
}

export function buildKnowledgeListPayload(
  repoDb: DB,
  globalDb: DB | null,
  filters: KnowledgeFilters = {},
): KnowledgeListPayload {
  const scope = filters.scope ?? "all";
  let results: Array<ReturnType<typeof queries.queryKnowledge>[number] & { scope: string }> = [];

  if (scope === "repo" || scope === "all") {
    results.push(...queries.queryKnowledge(repoDb, {
      type: filters.type,
      tags: filters.tags,
      status: filters.status,
    }).map((entry) => ({ ...entry, scope: "repo" })));
  }

  if ((scope === "global" || scope === "all") && globalDb) {
    results.push(...queries.queryKnowledge(globalDb, {
      type: filters.type,
      tags: filters.tags,
      status: filters.status,
    }).map((entry) => ({ ...entry, scope: "global" })));
  }

  if (filters.limit !== undefined) {
    results = results.slice(0, filters.limit);
  }

  return {
    count: results.length,
    entries: results.map((entry) => ({
      key: entry.key,
      type: entry.type,
      scope: entry.scope,
      title: entry.title,
      tags: parseStringArrayJson(entry.tagsJson, {
        maxItems: 25,
        maxItemLength: 64,
      }),
      status: entry.status,
      updatedAt: entry.updatedAt,
    })),
  };
}

export function buildKnowledgeDetailPayload(
  repoDb: DB,
  globalDb: DB | null,
  key: string,
  scope: KnowledgeScope = "all",
): KnowledgeDetailPayload | null {
  const candidates: Array<{ db: DB; scope: "repo" | "global" }> = [];
  if (scope === "repo" || scope === "all") candidates.push({ db: repoDb, scope: "repo" });
  if ((scope === "global" || scope === "all") && globalDb) candidates.push({ db: globalDb, scope: "global" });

  for (const candidate of candidates) {
    const entry = queries.getKnowledgeByKey(candidate.db, key);
    if (!entry) continue;
    return {
      key: entry.key,
      type: entry.type,
      scope: candidate.scope,
      title: entry.title,
      content: entry.content,
      tags: parseStringArrayJson(entry.tagsJson, {
        maxItems: 25,
        maxItemLength: 64,
      }),
      status: entry.status,
      agentId: entry.agentId,
      sessionId: entry.sessionId,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  return null;
}

export function buildKnowledgeSummaryPayload(
  repoDb: DB,
  globalDb: DB | null,
  filters: Omit<KnowledgeFilters, "limit"> = {},
): KnowledgeSummaryPayload {
  const list = buildKnowledgeListPayload(repoDb, globalDb, filters);
  const scopeCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};

  for (const entry of list.entries) {
    scopeCounts[entry.scope] = (scopeCounts[entry.scope] ?? 0) + 1;
    typeCounts[entry.type] = (typeCounts[entry.type] ?? 0) + 1;
    statusCounts[entry.status] = (statusCounts[entry.status] ?? 0) + 1;
  }

  return {
    totalCount: list.count,
    scopeCounts,
    typeCounts,
    statusCounts,
    recent: list.entries.slice(0, 10),
  };
}
