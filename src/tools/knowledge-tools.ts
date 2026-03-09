import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { createHash } from "node:crypto";
import type { AgoraContext } from "../core/context.js";
import * as queries from "../db/queries.js";
import { touchSession } from "../agents/registry.js";

type GetContext = () => Promise<AgoraContext>;

const KNOWLEDGE_TYPES = [
  "decision", "gotcha", "pattern", "context", "plan", "solution", "preference",
] as const;

export function registerKnowledgeTools(server: McpServer, getContext: GetContext): void {
  // ─── store_knowledge ───────────────────────────────────────
  server.tool(
    "store_knowledge",
    "Save knowledge with key-based upsert. Scope 'repo' saves to this project, 'global' saves cross-project to ~/.agora/.",
    {
      type: z.enum(KNOWLEDGE_TYPES).describe("Knowledge type"),
      scope: z.enum(["repo", "global"]).default("repo").describe("repo = this project, global = cross-project"),
      title: z.string().min(1).max(200).describe("Short title"),
      content: z.string().min(1).max(10_000).describe("Knowledge content"),
      tags: z.array(z.string()).default([]).describe("Tags for filtering"),
      agentId: z.string().optional().describe("Agent ID (optional)"),
      sessionId: z.string().optional().describe("Session ID (optional)"),
    },
    async ({ type, scope, title, content, tags, agentId, sessionId }) => {
      const c = await getContext();

      const targetDb = scope === "global" ? c.globalDb : c.db;
      const targetSqlite = scope === "global" ? c.globalSqlite : c.sqlite;

      if (!targetDb || !targetSqlite) {
        return {
          content: [{ type: "text" as const, text: `${scope} database not available` }],
          isError: true,
        };
      }

      // Touch session for live presence tracking
      if (sessionId) touchSession(c.db, sessionId);

      // Key based on title+type+scope so same-titled entries upsert instead of duplicating
      const keySource = `${type}:${scope}:${title}`;
      const keyHash = createHash("sha256").update(keySource).digest("hex").slice(0, 12);
      const key = `${type}:${keyHash}`;
      const now = new Date().toISOString();

      const entry = queries.upsertKnowledge(targetDb, {
        key, type, scope, title, content,
        tagsJson: JSON.stringify(tags),
        status: "active",
        agentId: agentId ?? null,
        sessionId: sessionId ?? null,
        createdAt: now,
        updatedAt: now,
      });

      // Generate and store embedding
      const reranker = c.searchRouter.getSemanticReranker();
      if (reranker?.isAvailable()) {
        try {
          const embedding = await reranker.embed(`${title}. ${content}`);
          if (embedding) {
            reranker.storeKnowledgeEmbedding(targetSqlite, entry.id, embedding);
          }
        } catch {
          // Non-fatal: knowledge stored without embedding
        }
      }

      // Rebuild knowledge FTS5 index to keep search in sync
      try { c.searchRouter.rebuildKnowledgeFts(targetSqlite); } catch { /* non-fatal */ }

      c.insight.info(`Knowledge stored: ${key} (${scope})`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ key, type, scope, title, knowledgeId: entry.id }, null, 2),
        }],
      };
    },
  );

  // ─── search_knowledge ──────────────────────────────────────
  server.tool(
    "search_knowledge",
    "Search knowledge by FTS5 full-text search, enhanced with semantic similarity when available. Searches both repo and global scopes by default.",
    {
      query: z.string().min(1).max(1000).describe("Search query"),
      scope: z.enum(["repo", "global", "all"]).default("all").describe("Which scope to search"),
      type: z.enum(KNOWLEDGE_TYPES).optional().describe("Filter by type"),
      limit: z.number().int().min(1).max(50).default(10).describe("Max results"),
    },
    async ({ query, scope, type, limit }) => {
      const c = await getContext();

      type ScoredEntry = { key: string; type: string; scope: string; title: string; content: string; tags: string[]; score: number };
      let results: ScoredEntry[] = [];

      // Primary: FTS5 search (always available, no model dependency)
      const searchFts5 = (sqlite: typeof c.sqlite, scopeLabel: string): ScoredEntry[] => {
        const ftsResults = c.searchRouter.searchKnowledge(sqlite, query, limit, type);
        // Enrich with full content from DB
        return ftsResults.map((r) => {
          const entry = queries.getKnowledgeById(
            scopeLabel === "global" ? c.globalDb! : c.db,
            r.knowledgeId,
          );
          return {
            key: entry?.key ?? `id:${r.knowledgeId}`,
            type: entry?.type ?? "unknown",
            scope: scopeLabel,
            title: r.title,
            content: entry?.content ?? "",
            tags: entry?.tagsJson ? JSON.parse(entry.tagsJson) : [],
            score: r.score,
          };
        }).filter((r) => r.content); // skip orphaned FTS entries
      };

      if (scope === "repo" || scope === "all") {
        results.push(...searchFts5(c.sqlite, "repo"));
      }
      if ((scope === "global" || scope === "all") && c.globalSqlite) {
        results.push(...searchFts5(c.globalSqlite, "global"));
      }

      // Enhance: if semantic model available, blend FTS5 + vector scores
      const reranker = c.searchRouter.getSemanticReranker();
      if (reranker?.isAvailable() && results.length > 0) {
        const queryEmbedding = await reranker.embed(query);
        if (queryEmbedding) {
          // Normalize FTS5 scores to [0,1]
          const maxFts5 = Math.max(...results.map((r) => r.score), 1);
          for (const r of results) {
            const targetSqlite = r.scope === "global" ? c.globalSqlite! : c.sqlite;
            const entry = queries.getKnowledgeByKey(
              r.scope === "global" ? c.globalDb! : c.db,
              r.key,
            );
            if (entry) {
              const rows = targetSqlite
                .prepare("SELECT embedding FROM knowledge WHERE id = ?")
                .get(entry.id) as { embedding: Buffer | null } | undefined;
              if (rows?.embedding) {
                const emb = new Float32Array(rows.embedding.buffer, rows.embedding.byteOffset, rows.embedding.byteLength / 4);
                const dot = Array.from(queryEmbedding).reduce((sum, v, i) => sum + v * emb[i]!, 0);
                const normA = Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0));
                const normB = Math.sqrt(Array.from(emb).reduce((s, v) => s + v * v, 0));
                const semantic = normA && normB ? (dot / (normA * normB) + 1) / 2 : 0.5;
                const normalizedFts5 = r.score / maxFts5;
                r.score = 0.5 * normalizedFts5 + 0.5 * semantic;
              }
            }
          }
        }
      }

      results.sort((a, b) => b.score - a.score);
      results = results.slice(0, limit);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            query, scope, count: results.length,
            results: results.map((r) => ({
              key: r.key, type: r.type, scope: r.scope, title: r.title,
              content: r.content.slice(0, 500) + (r.content.length > 500 ? "..." : ""),
              tags: r.tags,
              score: Math.round(r.score * 1000) / 1000,
            })),
          }, null, 2),
        }],
      };
    },
  );

  // ─── query_knowledge ───────────────────────────────────────
  server.tool(
    "query_knowledge",
    "List knowledge entries with structured filters (type, tags, status, scope). No semantic search.",
    {
      scope: z.enum(["repo", "global", "all"]).default("all").describe("Which scope"),
      type: z.enum(KNOWLEDGE_TYPES).optional().describe("Filter by type"),
      tags: z.array(z.string()).optional().describe("Filter by tags (AND logic)"),
      status: z.enum(["active", "archived"]).default("active").describe("Filter by status"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
    },
    async ({ scope, type, tags, status, limit }) => {
      const c = await getContext();
      const queryOpts = { type, tags, status };

      type EntryWithScope = ReturnType<typeof queries.queryKnowledge>[number] & { scope: string };
      let results: EntryWithScope[] = [];

      if (scope === "repo" || scope === "all") {
        const repoEntries = queries.queryKnowledge(c.db, queryOpts);
        results.push(...repoEntries.map((e) => ({ ...e, scope: "repo" })));
      }

      if ((scope === "global" || scope === "all") && c.globalDb) {
        const globalEntries = queries.queryKnowledge(c.globalDb, queryOpts);
        results.push(...globalEntries.map((e) => ({ ...e, scope: "global" })));
      }

      results = results.slice(0, limit);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: results.length,
            entries: results.map((e) => ({
              key: e.key, type: e.type, scope: e.scope, title: e.title,
              content: e.content.slice(0, 200) + (e.content.length > 200 ? "..." : ""),
              tags: e.tagsJson ? JSON.parse(e.tagsJson) : [],
              status: e.status,
              updatedAt: e.updatedAt,
            })),
          }, null, 2),
        }],
      };
    },
  );

  // ─── archive_knowledge ─────────────────────────────────────
  server.tool(
    "archive_knowledge",
    "Soft-delete: mark a knowledge entry as archived. Still queryable with status='archived'.",
    {
      key: z.string().describe("Knowledge entry key"),
      scope: z.enum(["repo", "global"]).describe("Which scope the entry is in"),
    },
    async ({ key, scope }) => {
      const c = await getContext();
      const targetDb = scope === "global" ? c.globalDb : c.db;

      if (!targetDb) {
        return {
          content: [{ type: "text" as const, text: `${scope} database not available` }],
          isError: true,
        };
      }

      const existing = queries.getKnowledgeByKey(targetDb, key);
      if (!existing) {
        return {
          content: [{ type: "text" as const, text: `Not found: ${key}` }],
          isError: true,
        };
      }

      queries.archiveKnowledge(targetDb, key);

      // Rebuild knowledge FTS5 (archived entries removed from FTS)
      const archiveSqlite = scope === "global" ? c.globalSqlite : c.sqlite;
      if (archiveSqlite) {
        try { c.searchRouter.rebuildKnowledgeFts(archiveSqlite); } catch { /* non-fatal */ }
      }

      c.insight.info(`Knowledge archived: ${key} (${scope})`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ archived: true, key, scope }, null, 2),
        }],
      };
    },
  );

  // ─── delete_knowledge ──────────────────────────────────────
  server.tool(
    "delete_knowledge",
    "Hard-delete: permanently remove a knowledge entry. Use for completed plans, obsolete gotchas.",
    {
      key: z.string().describe("Knowledge entry key"),
      scope: z.enum(["repo", "global"]).describe("Which scope the entry is in"),
    },
    async ({ key, scope }) => {
      const c = await getContext();
      const targetDb = scope === "global" ? c.globalDb : c.db;

      if (!targetDb) {
        return {
          content: [{ type: "text" as const, text: `${scope} database not available` }],
          isError: true,
        };
      }

      const existing = queries.getKnowledgeByKey(targetDb, key);
      if (!existing) {
        return {
          content: [{ type: "text" as const, text: `Not found: ${key}` }],
          isError: true,
        };
      }

      queries.deleteKnowledge(targetDb, key);

      // Rebuild knowledge FTS5 (deleted entries removed from FTS)
      const deleteSqlite = scope === "global" ? c.globalSqlite : c.sqlite;
      if (deleteSqlite) {
        try { c.searchRouter.rebuildKnowledgeFts(deleteSqlite); } catch { /* non-fatal */ }
      }

      c.insight.info(`Knowledge deleted: ${key} (${scope})`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ deleted: true, key, scope }, null, 2),
        }],
      };
    },
  );
}
