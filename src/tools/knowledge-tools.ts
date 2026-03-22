import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { createHash } from "node:crypto";
import type { AgoraContext } from "../core/context.js";
import {
  AgentIdSchema,
  KnowledgeKeySchema,
  SessionIdSchema,
  TagsSchema,
} from "../core/input-hardening.js";
import * as queries from "../db/queries.js";
import { buildKnowledgeSearchBriefPayload, buildKnowledgeSearchPayload, searchKnowledgeEntries } from "../knowledge/search.js";
import { buildKnowledgeListPayload } from "../knowledge/read-model.js";
import { checkToolAccess } from "../trust/tiers.js";
import { resolveAgent } from "./resolve-agent.js";
import { recordDashboardEvent } from "../core/events.js";

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
      tags: TagsSchema.default([]).describe("Tags for filtering"),
      agentId: AgentIdSchema.describe("Agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ type, scope, title, content, tags, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

      const access = checkToolAccess("store_knowledge", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ denied: true, reason: access.reason }),
          }],
          isError: true,
        };
      }

      const targetDb = scope === "global" ? c.globalDb : c.db;
      const targetSqlite = scope === "global" ? c.globalSqlite : c.sqlite;

      if (!targetDb || !targetSqlite) {
        return {
          content: [{ type: "text" as const, text: `${scope} database not available` }],
          isError: true,
        };
      }

      // Key based on title+type+scope so same-titled entries upsert instead of duplicating
      const keySource = `${type}:${scope}:${title}`;
      const keyHash = createHash("sha256").update(keySource).digest("hex").slice(0, 12);
      const key = `${type}:${keyHash}`;
      const now = new Date().toISOString();

      const entry = queries.upsertKnowledge(targetDb, {
        key, type, scope, title, content,
        tagsJson: JSON.stringify(tags),
        status: "active",
        agentId,
        sessionId,
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
      recordDashboardEvent(c.db, c.repoId, {
        type: "knowledge_stored",
        data: { key, knowledgeType: type, scope, title, knowledgeId: entry.id, agentId },
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ key, type, scope, title, knowledgeId: entry.id }),
        }],
      };
    },
  );

  // ─── search_knowledge ──────────────────────────────────────
  server.tool(
    "search_knowledge",
    "Search knowledge by FTS5 full-text search, enhanced with semantic similarity when available. Use summary=true to return only keys/titles/scores (no content/tags) for browsing.",
    {
      query: z.string().trim().min(1).max(1000).describe("Search query"),
      scope: z.enum(["repo", "global", "all"]).default("all").describe("Which scope to search"),
      type: z.enum(KNOWLEDGE_TYPES).optional().describe("Filter by type"),
      limit: z.number().int().min(1).max(50).default(10).describe("Max results"),
      summary: z.boolean().default(false).describe("Return only key, title, type, and score (no content or tags). ~90% smaller."),
    },
    async ({ query, scope, type, limit, summary }) => {
      const c = await getContext();
      const results = await searchKnowledgeEntries({
        db: c.db,
        sqlite: c.sqlite,
        globalDb: c.globalDb,
        globalSqlite: c.globalSqlite,
        searchRouter: c.searchRouter,
      }, {
        query,
        scope,
        type,
        limit,
      });

      const payload = summary
        ? buildKnowledgeSearchBriefPayload(query, scope, results)
        : buildKnowledgeSearchPayload(query, scope, results);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(payload),
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
      tags: TagsSchema.optional().describe("Filter by tags (AND logic)"),
      status: z.enum(["active", "archived"]).default("active").describe("Filter by status"),
      limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
    },
    async ({ scope, type, tags, status, limit }) => {
      const c = await getContext();
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(buildKnowledgeListPayload(c.db, c.globalDb, {
            scope,
            type,
            tags,
            status,
            limit,
          })),
        }],
      };
    },
  );

  // ─── archive_knowledge ─────────────────────────────────────
  server.tool(
    "archive_knowledge",
    "Soft-delete: mark a knowledge entry as archived. Still queryable with status='archived'.",
    {
      key: KnowledgeKeySchema.describe("Knowledge entry key"),
      scope: z.enum(["repo", "global"]).describe("Which scope the entry is in"),
      agentId: AgentIdSchema.describe("Agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ key, scope, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

      const access = checkToolAccess("archive_knowledge", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ denied: true, reason: access.reason }),
          }],
          isError: true,
        };
      }

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
          text: JSON.stringify({ archived: true, key, scope }),
        }],
      };
    },
  );

  // ─── delete_knowledge ──────────────────────────────────────
  server.tool(
    "delete_knowledge",
    "Hard-delete: permanently remove a knowledge entry. Use for completed plans, obsolete gotchas.",
    {
      key: KnowledgeKeySchema.describe("Knowledge entry key"),
      scope: z.enum(["repo", "global"]).describe("Which scope the entry is in"),
      agentId: AgentIdSchema.describe("Agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ key, scope, agentId, sessionId }) => {
      const c = await getContext();
      const result = resolveAgent(c, agentId, sessionId);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          isError: true,
        };
      }
      const resolved = result.agent;

      const access = checkToolAccess("delete_knowledge", resolved.role, resolved.trustTier);
      if (!access.allowed) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ denied: true, reason: access.reason }),
          }],
          isError: true,
        };
      }

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
          text: JSON.stringify({ deleted: true, key, scope }),
        }],
      };
    },
  );
}
