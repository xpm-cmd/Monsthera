import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { VERSION, SUPPORTED_LANGUAGES, STAGE_A_MAX_CANDIDATES, STAGE_B_MAX_EXPANDED, MIN_RELEVANCE_SCORE, MIN_RELEVANCE_SCORE_SCOPED, MAX_DIFF_LINES_PER_FILE, HEARTBEAT_TIMEOUT_MS } from "../core/constants.js";
import type { AgoraContext } from "../core/context.js";
import * as queries from "../db/queries.js";
import { buildEvidenceBundle } from "../retrieval/evidence-bundle.js";
import { getHead, getChangedFiles, getDiffStats, getPerFileDiffs, getRecentCommits, isValidCommit } from "../git/operations.js";
import { getIndexedCommit, incrementalIndex } from "../indexing/indexer.js";
import { CAPABILITY_TOOL_NAMES } from "./tool-manifest.js";

type GetContext = () => Promise<AgoraContext>;

export function registerReadTools(server: McpServer, getContext: GetContext): void {
  // ─── status ───────────────────────────────────────────────
  server.tool("status", "Get Agora index status and connected agents", {}, async () => {
    const c = await getContext();
    const indexState = queries.getIndexState(c.db, c.repoId);
    const activeSessions = queries.getLiveSessions(
      c.db,
      new Date(Date.now() - HEARTBEAT_TIMEOUT_MS).toISOString(),
    );
    const head = await getHead({ cwd: c.repoPath });

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          version: VERSION,
          repoPath: c.repoPath,
          coordinationTopology: c.config.coordinationTopology,
          indexedCommit: indexState?.dbIndexedCommit ?? null,
          currentHead: head,
          indexStale: indexState?.dbIndexedCommit !== head,
          fileCount: queries.getFileCount(c.db, c.repoId),
          connectedAgents: activeSessions.length,
          searchBackend: c.searchRouter.getActiveBackendName(),
          debugLogging: c.config.debugLogging,
        }, null, 2),
      }],
    };
  });

  // ─── capabilities ─────────────────────────────────────────
  server.tool("capabilities", "List Agora capabilities and supported features", {}, async () => {
    const c = await getContext();
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          version: VERSION,
          tools: [...CAPABILITY_TOOL_NAMES],
          ticketStatuses: ["backlog", "technical_analysis", "assigned", "in_progress", "in_review", "blocked", "resolved", "closed", "wont_fix"],
          ticketSeverities: ["critical", "high", "medium", "low"],
          languages: [...SUPPORTED_LANGUAGES],
          trustTiers: ["A", "B"],
          roles: ["developer", "reviewer", "observer", "admin"],
          coordinationTopologies: ["hub-spoke", "hybrid", "mesh"],
          maxCandidates: STAGE_A_MAX_CANDIDATES,
          maxExpanded: STAGE_B_MAX_EXPANDED,
          maxCodeSpanLines: 200,
          semanticSearch: {
            available: c.searchRouter.getSemanticReranker()?.isAvailable() ?? false,
            model: "all-MiniLM-L6-v2",
            embeddingDim: 384,
          },
        }, null, 2),
      }],
    };
  });

  // ─── schema ───────────────────────────────────────────────
  server.tool(
    "schema",
    "Get the input schema for a specific Agora tool",
    { toolName: z.string().describe("Tool name") },
    async ({ toolName }) => {
      const schemas: Record<string, object> = {
        // ── read tools ──
        status: {},
        capabilities: {},
        schema: { toolName: "string (required)" },
        get_code_pack: {
          query: "string (1-1000 chars, required)",
          scope: "string (optional path prefix filter)",
          expand: "boolean (default false)",
        },
        get_change_pack: {
          sinceCommit: "string (optional, defaults to last 5 commits)",
        },
        get_issue_pack: {
          query: "string (1-1000 chars, required)",
        },
        // ── knowledge tools ──
        store_knowledge: {
          type: "enum: decision|gotcha|pattern|context|plan|solution|preference",
          scope: "enum: repo|global (default repo)",
          title: "string (1-200 chars)",
          content: "string (1-10000 chars)",
          tags: "string[] (optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        search_knowledge: {
          query: "string (1-1000 chars)",
          scope: "enum: repo|global|all (default all)",
          type: "enum (optional, same as store_knowledge.type)",
          limit: "number 1-50 (default 10)",
        },
        query_knowledge: {
          scope: "enum: repo|global|all (default all)",
          type: "enum (optional)",
          tags: "string[] (optional, AND logic)",
          status: "enum: active|archived (default active)",
          limit: "number 1-100 (default 20)",
        },
        archive_knowledge: {
          key: "string",
          scope: "enum: repo|global",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        delete_knowledge: {
          key: "string",
          scope: "enum: repo|global",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── coordination tools ──
        send_coordination: {
          type: "enum: task_claim|task_release|patch_intent|conflict_alert|status_update|broadcast",
          payload: "object (arbitrary key-value)",
          to: "string|null (default null = broadcast)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        poll_coordination: {
          agentId: "string (required)",
          sessionId: "string (required)",
          since: "string ISO timestamp (optional)",
          limit: "number 1-100 (default 20)",
        },
        // ── agent tools ──
        register_agent: {
          name: "string (1-100 chars)",
          type: "string (default unknown)",
          desiredRole: "enum: developer|reviewer|observer|admin (default observer)",
          authToken: "string (optional, required when registrationAuth is enabled for the requested role)",
        },
        agent_status: { agentId: "string (optional, omit for all)" },
        broadcast: {
          message: "string (1-500 chars)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        claim_files: {
          agentId: "string (required)",
          sessionId: "string (required)",
          paths: "string[] (1-50 paths, advisory lock)",
        },
        end_session: {
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── index tools ──
        request_reindex: {
          full: "boolean (default false)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── patch tools ──
        propose_patch: {
          diff: "string (unified diff, required)",
          message: "string (1-1000 chars)",
          baseCommit: "string (min 7 chars SHA)",
          bundleId: "string (optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
          dryRun: "boolean (default false)",
          ticketId: "string (optional, links patch to ticket)",
        },
        list_patches: {
          state: "enum: proposed|validated|applied|committed|stale|failed (optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── note tools ──
        propose_note: {
          type: "enum: issue|decision|change_note|gotcha|runbook|repo_map|module_map|file_summary",
          content: "string (1-10000 chars)",
          linkedPaths: "string[] (optional)",
          metadata: "object (optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        list_notes: {
          type: "enum: issue|decision|change_note|gotcha|runbook|repo_map|module_map|file_summary (optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        // ── ticket tools ──
        create_ticket: {
          title: "string (1-200 chars)",
          description: "string (1-5000 chars)",
          severity: "enum: critical|high|medium|low (default medium)",
          priority: "number 0-10 (default 5)",
          tags: "string[] (optional)",
          affectedPaths: "string[] (optional)",
          acceptanceCriteria: "string (optional, max 2000)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        assign_ticket: {
          ticketId: "string (TKT-...)",
          assigneeAgentId: "string (required)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        update_ticket_status: {
          ticketId: "string (TKT-...)",
          status: "enum: backlog|technical_analysis|assigned|in_progress|in_review|blocked|resolved|closed|wont_fix",
          comment: "string (optional, max 500)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        update_ticket: {
          ticketId: "string (TKT-...)",
          title: "string (optional)",
          description: "string (optional)",
          severity: "enum (optional)",
          priority: "number 0-10 (optional)",
          tags: "string[] (optional)",
          affectedPaths: "string[] (optional)",
          acceptanceCriteria: "string (optional)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        list_tickets: {
          agentId: "string (required)",
          sessionId: "string (required)",
          status: "enum (optional)",
          assigneeAgentId: "string (optional)",
          severity: "enum (optional)",
          creatorAgentId: "string (optional)",
          tags: "string[] (optional, AND logic filter)",
          limit: "number 1-100 (default 20)",
        },
        get_ticket: {
          ticketId: "string (TKT-...)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
        comment_ticket: {
          ticketId: "string (TKT-...)",
          content: "string (1-2000 chars)",
          agentId: "string (required)",
          sessionId: "string (required)",
        },
      };

      const s = schemas[toolName];
      if (!s) {
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${toolName}` }],
          isError: true,
        };
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ tool: toolName, inputSchema: s }, null, 2),
        }],
      };
    },
  );

  // ─── get_code_pack ────────────────────────────────────────
  server.tool(
    "get_code_pack",
    "Search for relevant code files and return an Evidence Bundle. Auto-reindexes incrementally when stale. For convention, architecture, or historical questions, use get_issue_pack instead.",
    {
      query: z.string().min(1).max(1000).describe("Search query"),
      scope: z.string().optional().describe("Path scope filter"),
      expand: z.boolean().default(false).describe("Include code spans"),
    },
    async ({ query, scope, expand }) => {
      const c = await getContext();
      const head = await getHead({ cwd: c.repoPath });
      const indexedCommit = getIndexedCommit(c.db, c.repoId);

      if (!indexedCommit) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "No index available. Run request_reindex first.",
              indexStale: true,
              currentHead: head,
            }, null, 2),
          }],
          isError: true,
        };
      }

      // Auto-incremental reindex when stale (cheap: just git diff + changed files)
      let autoReindexed = false;
      let effectiveCommit = indexedCommit;
      if (indexedCommit !== head) {
        try {
          const result = await incrementalIndex(indexedCommit, {
            repoPath: c.repoPath,
            repoId: c.repoId,
            db: c.db,
            sensitiveFilePatterns: c.config.sensitiveFilePatterns,
            excludePatterns: c.config.excludePatterns,
            onProgress: (msg) => c.insight.detail(msg),
            semanticReranker: c.searchRouter.getSemanticReranker(),
          });
          await c.searchRouter.rebuildIndex(c.repoId);
          autoReindexed = true;
          effectiveCommit = result.commit;
          c.insight.info(`Auto-reindex: ${result.filesIndexed} files in ${result.durationMs}ms`);
        } catch {
          // Non-fatal: search with stale index rather than fail
          c.insight.debug("Auto-reindex failed, using stale index");
        }
      }

      const rawResults = await c.searchRouter.search(query, c.repoId, 10, scope);
      // Nonsense guard: dynamic threshold — scoped queries have smaller candidate pools so scores are lower
      const threshold = scope ? MIN_RELEVANCE_SCORE_SCOPED : MIN_RELEVANCE_SCORE;
      const searchResults = rawResults.filter((r) => r.score >= threshold);
      c.insight.debug(`get_code_pack: "${query}" → ${rawResults.length} raw, ${searchResults.length} above threshold (${threshold})`);

      const bundle = await buildEvidenceBundle({
        query,
        repoId: c.repoId,
        repoPath: c.repoPath,
        commit: effectiveCommit,
        trustTier: "A",
        searchBackend: c.searchRouter.getActiveBackendName(),
        searchResults,
        db: c.db,
        expand,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ...bundle,
            indexStale: !autoReindexed && indexedCommit !== head,
            currentHead: head,
            ...(autoReindexed && { autoReindexed: true }),
          }, null, 2),
        }],
      };
    },
  );

  // ─── get_change_pack ──────────────────────────────────────
  server.tool(
    "get_change_pack",
    "Get recently changed files with summaries and commit context",
    {
      sinceCommit: z.string().optional().describe("Base commit (defaults to last 5)"),
    },
    async ({ sinceCommit }) => {
      const c = await getContext();
      const head = await getHead({ cwd: c.repoPath });

      let base = sinceCommit;
      if (base) {
        const valid = await isValidCommit(base, { cwd: c.repoPath });
        if (!valid) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: `Invalid commit hash: ${base}`,
                hint: "Provide a valid commit SHA or omit sinceCommit to use recent history",
              }, null, 2),
            }],
            isError: true,
          };
        }
      } else {
        const recent = await getRecentCommits(6, { cwd: c.repoPath });
        base = recent.at(-1)?.sha ?? head;
      }

      const changes = await getChangedFiles(base, head, { cwd: c.repoPath });
      const [diffStats, fileDiffs] = await Promise.all([
        getDiffStats(base, head, { cwd: c.repoPath }),
        getPerFileDiffs(base, head, MAX_DIFF_LINES_PER_FILE, { cwd: c.repoPath }),
      ]);
      c.insight.debug(`get_change_pack: ${changes.length} files since ${base.slice(0, 7)}`);

      const enriched = changes.map((ch) => {
        const f = queries.getFileByPath(c.db, c.repoId, ch.path);
        const stats = diffStats.get(ch.path);
        return {
          status: ch.status,
          path: ch.path,
          language: f?.language ?? null,
          summary: f?.summary ?? null,
          hasSecrets: f?.hasSecrets ?? false,
          linesAdded: stats?.added ?? null,
          linesRemoved: stats?.removed ?? null,
          diff: fileDiffs.get(ch.path) ?? null,
        };
      });

      const recentCommits = await getRecentCommits(5, { cwd: c.repoPath });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            currentHead: head,
            sinceCommit: base,
            changedFiles: enriched,
            recentCommits,
          }, null, 2),
        }],
      };
    },
  );

  // ─── get_issue_pack ───────────────────────────────────────
  server.tool(
    "get_issue_pack",
    "Search notes (issues, decisions, change notes) for context",
    {
      query: z.string().min(1).max(1000).describe("Search query"),
    },
    async ({ query }) => {
      const c = await getContext();
      const head = await getHead({ cwd: c.repoPath });

      const allNotes = queries.getNotesByRepo(c.db, c.repoId);
      const q = query.toLowerCase();
      const matchedNotes = allNotes.filter((n) =>
        n.content.toLowerCase().includes(q) ||
        n.key.toLowerCase().includes(q) ||
        n.type.toLowerCase().includes(q),
      );

      // Search knowledge entries via FTS5 (always available, no model dependency)
      const searchKnowledgeFts = (sqlite: typeof c.sqlite, db: typeof c.db, scopeLabel: string) => {
        const ftsResults = c.searchRouter.searchKnowledge(sqlite, query, 10);
        return ftsResults.map((r) => {
          const entry = queries.getKnowledgeById(db, r.knowledgeId);
          if (!entry) return null;
          return {
            key: entry.key,
            type: entry.type,
            scope: scopeLabel,
            title: entry.title,
            content: entry.content.slice(0, 500) + (entry.content.length > 500 ? "..." : ""),
            tags: entry.tagsJson ? JSON.parse(entry.tagsJson) : [],
            updatedAt: entry.updatedAt,
          };
        }).filter(Boolean);
      };

      const matchedKnowledge = [
        ...searchKnowledgeFts(c.sqlite, c.db, "repo"),
        ...(c.globalSqlite && c.globalDb ? searchKnowledgeFts(c.globalSqlite, c.globalDb, "global") : []),
      ];

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            currentHead: head,
            query,
            matchedNotes: matchedNotes.map((n) => ({
              key: n.key,
              type: n.type,
              content: n.content,
              linkedPaths: n.linkedPathsJson ? JSON.parse(n.linkedPathsJson) : [],
              agentId: n.agentId,
              commitSha: n.commitSha,
              updatedAt: n.updatedAt,
            })),
            matchedKnowledge,
          }, null, 2),
        }],
      };
    },
  );
}
