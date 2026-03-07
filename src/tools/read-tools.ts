import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { VERSION, SUPPORTED_LANGUAGES } from "../core/constants.js";
import type { AgoraContext } from "../core/context.js";
import * as queries from "../db/queries.js";
import { buildEvidenceBundle } from "../retrieval/evidence-bundle.js";
import { getHead, getChangedFiles, getRecentCommits } from "../git/operations.js";
import { getIndexedCommit } from "../indexing/indexer.js";

type GetContext = () => Promise<AgoraContext>;

export function registerReadTools(server: McpServer, getContext: GetContext): void {
  // ─── status ───────────────────────────────────────────────
  server.tool("status", "Get Agora index status and connected agents", {}, async () => {
    const c = await getContext();
    const indexState = queries.getIndexState(c.db, c.repoId);
    const activeSessions = queries.getActiveSessions(c.db);
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
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          version: VERSION,
          tools: [
            "status", "capabilities", "schema",
            "get_code_pack", "get_change_pack", "get_issue_pack",
            "propose_patch", "propose_note",
            "register_agent", "agent_status", "broadcast",
            "claim_files", "request_reindex",
          ],
          languages: [...SUPPORTED_LANGUAGES],
          trustTiers: ["A", "B"],
          roles: ["developer", "reviewer", "observer", "admin"],
          coordinationTopologies: ["hub-spoke", "hybrid", "mesh"],
          maxCandidates: 5,
          maxExpanded: 3,
          maxCodeSpanLines: 200,
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
        get_code_pack: {
          query: "string (1-1000 chars, required)",
          scope: "string (optional path scope)",
          expand: "boolean (default false)",
        },
        get_change_pack: {
          sinceCommit: "string (optional, defaults to last 5 commits)",
        },
        get_issue_pack: {
          query: "string (1-1000 chars, required)",
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
    "Search for relevant code and return an Evidence Bundle",
    {
      query: z.string().min(1).max(1000).describe("Search query"),
      scope: z.string().optional().describe("Path scope filter"),
      expand: z.boolean().default(false).describe("Include code spans"),
    },
    async ({ query, expand }) => {
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

      const searchResults = await c.searchRouter.search(query, c.repoId, 10);
      c.insight.debug(`get_code_pack: "${query}" → ${searchResults.length} hits`);

      const bundle = await buildEvidenceBundle({
        query,
        repoId: c.repoId,
        repoPath: c.repoPath,
        commit: indexedCommit,
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
            indexStale: indexedCommit !== head,
            currentHead: head,
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
      if (!base) {
        const recent = await getRecentCommits(6, { cwd: c.repoPath });
        base = recent.at(-1)?.sha ?? head;
      }

      const changes = await getChangedFiles(base, head, { cwd: c.repoPath });
      c.insight.debug(`get_change_pack: ${changes.length} files since ${base.slice(0, 7)}`);

      const enriched = changes.map((ch) => {
        const f = queries.getFileByPath(c.db, c.repoId, ch.path);
        return {
          status: ch.status,
          path: ch.path,
          language: f?.language ?? null,
          summary: f?.summary ?? null,
          hasSecrets: f?.hasSecrets ?? false,
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
      const matched = allNotes.filter((n) =>
        n.content.toLowerCase().includes(q) ||
        n.key.toLowerCase().includes(q) ||
        n.type.toLowerCase().includes(q),
      );

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            currentHead: head,
            query,
            matchedNotes: matched.map((n) => ({
              key: n.key,
              type: n.type,
              content: n.content,
              linkedPaths: n.linkedPathsJson ? JSON.parse(n.linkedPathsJson) : [],
              agentId: n.agentId,
              commitSha: n.commitSha,
              updatedAt: n.updatedAt,
            })),
          }, null, 2),
        }],
      };
    },
  );
}
