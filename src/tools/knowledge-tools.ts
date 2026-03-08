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

      const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 12);
      const key = `${type}:${contentHash}`;
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
    "Search knowledge by semantic similarity. Searches both repo and global scopes by default, merges results.",
    {
      query: z.string().min(1).max(1000).describe("Search query"),
      scope: z.enum(["repo", "global", "all"]).default("all").describe("Which scope to search"),
      type: z.enum(KNOWLEDGE_TYPES).optional().describe("Filter by type"),
      limit: z.number().int().min(1).max(50).default(10).describe("Max results"),
    },
    async ({ query, scope, type, limit }) => {
      const c = await getContext();
      const reranker = c.searchRouter.getSemanticReranker();

      type ScoredEntry = { key: string; type: string; scope: string; title: string; content: string; tags: string[]; score: number };
      let results: ScoredEntry[] = [];

      // Try semantic search first
      if (reranker?.isAvailable()) {
        const queryEmbedding = await reranker.embed(query);
        if (queryEmbedding) {
          if (scope === "repo" || scope === "all") {
            const repoResults = reranker.searchKnowledgeByVector(c.sqlite, queryEmbedding, limit);
            results.push(...repoResults.map((r) => ({
              key: r.key, type: r.type, scope: "repo", title: r.title, content: r.content,
              tags: r.tagsJson ? JSON.parse(r.tagsJson) : [], score: r.score,
            })));
          }
          if ((scope === "global" || scope === "all") && c.globalSqlite) {
            const globalResults = reranker.searchKnowledgeByVector(c.globalSqlite, queryEmbedding, limit);
            results.push(...globalResults.map((r) => ({
              key: r.key, type: r.type, scope: "global", title: r.title, content: r.content,
              tags: r.tagsJson ? JSON.parse(r.tagsJson) : [], score: r.score,
            })));
          }
          results.sort((a, b) => b.score - a.score);
          results = results.slice(0, limit);
        }
      }

      // Fallback: substring search
      if (results.length === 0) {
        const q = query.toLowerCase();
        const searchDb = (db: typeof c.db, scopeLabel: string): ScoredEntry[] => {
          const all = queries.queryKnowledge(db, { type, status: "active" });
          return all
            .filter((k) => k.title.toLowerCase().includes(q) || k.content.toLowerCase().includes(q))
            .map((k) => ({
              key: k.key, type: k.type, scope: scopeLabel, title: k.title,
              content: k.content, tags: k.tagsJson ? JSON.parse(k.tagsJson) : [],
              score: 1,
            }));
        };

        if (scope === "repo" || scope === "all") {
          results.push(...searchDb(c.db, "repo"));
        }
        if ((scope === "global" || scope === "all") && c.globalDb) {
          results.push(...searchDb(c.globalDb, "global"));
        }
        results = results.slice(0, limit);
      }

      // Post-filter by type if semantic search didn't pre-filter
      if (type) {
        results = results.filter((r) => r.type === type);
      }

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
