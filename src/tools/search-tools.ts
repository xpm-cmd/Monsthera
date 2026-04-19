import type { SearchService } from "../search/service.js";
import type { KnowledgeArticleRepository } from "../knowledge/repository.js";
import type { WorkArticleRepository } from "../work/repository.js";
import type { SnapshotService } from "../context/snapshot-service.js";
import type { ToolDefinition, ToolResponse } from "./knowledge-tools.js";
import { successResponse, errorResponse, requireString, isErrorResponse, requireEnum } from "./validation.js";

export type { ToolDefinition, ToolResponse };

/** Optional deps needed to enrich build_context_pack with full article content. */
export interface SearchToolDeps {
  readonly knowledgeRepo: Pick<KnowledgeArticleRepository, "findById">;
  readonly workRepo: Pick<WorkArticleRepository, "findById">;
  readonly snapshotService?: SnapshotService;
}

/** Returns the search tool definitions for MCP ListTools */
export function searchToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "search",
      description:
        "Quick discovery across knowledge and work articles with BM25 keyword ranking. Queries work best with specific keywords (1-3 terms, AND semantics); longer queries use OR semantics ranked by BM25. For deep coding or investigation, prefer build_context_pack. Normal CRUD flows sync search automatically; use reindex_all only for bulk backfills or repair.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          type: {
            type: "string",
            enum: ["knowledge", "work", "all"],
            description: "Filter by article type",
          },
          limit: { type: "number", description: "Maximum results (1-100, default 20)" },
          offset: { type: "number", description: "Skip N results (default 0)" },
        },
        required: ["query"],
      },
    },
    {
      name: "build_context_pack",
      description:
        "Recommended first step before coding or investigation. Builds a ranked context pack using search plus freshness, quality, and code-link signals so agents can read less, plan faster, and then open only the top knowledge/work items. Pass `include_content: true` to inline the full body of each ranked item (skips the per-result get_article / get_work round-trip).",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query used to assemble the pack" },
          mode: {
            type: "string",
            enum: ["general", "code", "research"],
            description: "Optimize the pack for general planning, code generation, or investigation",
          },
          type: {
            type: "string",
            enum: ["knowledge", "work", "all"],
            description: "Filter by article type",
          },
          limit: { type: "number", description: "Maximum context pack items (1-20, default 8)" },
          verbose: { type: "boolean", description: "Include full diagnostics and metadata (default false)" },
          include_content: {
            type: "boolean",
            description: "Inline the full `content` of each ranked article alongside the snippet, so agents can skip follow-up get_article / get_work calls (default false — slim response is the default).",
          },
          agent_id: {
            type: "string",
            description: "When provided, the pack includes the agent's most recent environment snapshot (cwd, runtimes, lockfiles, etc.) so semantic context arrives alongside physical context.",
          },
          work_id: {
            type: "string",
            description: "When provided, the pack includes the snapshot recorded against this work article (preferred over agent_id when both are set; falls back to agent_id if none was recorded for the work).",
          },
          exclude_ids: {
            type: "array",
            items: { type: "string" },
            description: "Article IDs to drop from the ranking before top-N selection. Useful when `work_id` is set and the caller already has that article in hand — pass `[work_id]` to free the slot. Not auto-populated from `work_id`, to preserve backwards compatibility; opt in explicitly.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "index_article",
      description: "Index or re-index a specific article for search. This is mainly for repair or backfill flows; normal create/update flows already sync automatically.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Article ID" },
          source: {
            type: "string",
            enum: ["knowledge", "work"],
            description: "Article source type",
          },
        },
        required: ["id", "source"],
      },
    },
    {
      name: "remove_from_index",
      description: "Remove an article from the search index. This is mainly for repair flows; normal delete flows already sync automatically.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Article ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "reindex_all",
      description:
        "Rebuild the entire search index from all knowledge and work articles. Use this only after migrations, bulk imports, or recovery work.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
  ];
}

// ─── Valid source values ──────────────────────────────────────────────────────

const VALID_SOURCES = new Set(["knowledge", "work"]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the full body of every ranked pack item in parallel. Missing
 * articles (e.g. deleted after indexing) are skipped silently rather than
 * failing the whole request — the caller still gets the rank plus whatever
 * content survives.
 */
async function loadContentForPack(
  items: readonly { id: string; type: "knowledge" | "work" }[],
  deps: SearchToolDeps,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const results = await Promise.all(
    items.map(async (item) => {
      const repo = item.type === "knowledge" ? deps.knowledgeRepo : deps.workRepo;
      const res = await repo.findById(item.id);
      return res.ok ? ([item.id, res.value.content] as const) : null;
    }),
  );
  for (const entry of results) {
    if (entry !== null) out.set(entry[0], entry[1]);
  }
  return out;
}

/**
 * Resolve the latest snapshot for a (workId, agentId) scope. Returns null when
 * no lookup id was provided, the snapshot service is unwired, or the lookup
 * found nothing. Service-level errors are logged implicitly by the service and
 * surfaced here as null — a missing snapshot must never fail the whole pack.
 */
async function loadSnapshotForPack(
  lookup: { agentId?: string; workId?: string },
  deps?: SearchToolDeps,
): Promise<
  | {
      readonly id: string;
      readonly agentId: string;
      readonly workId?: string;
      readonly capturedAt: string;
      readonly ageSeconds: number;
      readonly stale: boolean;
      readonly cwd: string;
      readonly gitRef?: { branch?: string; sha?: string; dirty?: boolean };
      readonly runtimes: Record<string, string>;
      readonly packageManagers: readonly string[];
      readonly lockfiles: readonly { path: string; sha256: string }[];
      readonly files: readonly string[];
    }
  | null
> {
  if (!deps?.snapshotService) return null;
  if (!lookup.agentId && !lookup.workId) return null;

  const result = await deps.snapshotService.getLatest(lookup);
  if (!result.ok || !result.value) return null;

  const { snapshot, ageSeconds, stale } = result.value;
  return {
    id: snapshot.id,
    agentId: snapshot.agentId,
    workId: snapshot.workId,
    capturedAt: snapshot.capturedAt,
    ageSeconds,
    stale,
    cwd: snapshot.cwd,
    gitRef: snapshot.gitRef,
    runtimes: snapshot.runtimes,
    packageManagers: snapshot.packageManagers,
    lockfiles: snapshot.lockfiles,
    files: snapshot.files,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

/** Handle a search tool call */
export async function handleSearchTool(
  name: string,
  args: Record<string, unknown>,
  service: SearchService,
  deps?: SearchToolDeps,
): Promise<ToolResponse> {
  switch (name) {
    case "search": {
      const result = await service.search(args);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "build_context_pack": {
      if (args.include_content !== undefined && typeof args.include_content !== "boolean") {
        return errorResponse("VALIDATION_FAILED", `"include_content" must be a boolean`);
      }
      if (args.agent_id !== undefined && typeof args.agent_id !== "string") {
        return errorResponse("VALIDATION_FAILED", `"agent_id" must be a string`);
      }
      if (args.work_id !== undefined && typeof args.work_id !== "string") {
        return errorResponse("VALIDATION_FAILED", `"work_id" must be a string`);
      }
      if (args.exclude_ids !== undefined) {
        if (!Array.isArray(args.exclude_ids)) {
          return errorResponse("VALIDATION_FAILED", `"exclude_ids" must be an array of strings`);
        }
        if (args.exclude_ids.some((v) => typeof v !== "string")) {
          return errorResponse("VALIDATION_FAILED", `"exclude_ids" must be an array of strings`);
        }
      }
      const includeContent = args.include_content === true;
      const agentId = typeof args.agent_id === "string" ? args.agent_id : undefined;
      const workId = typeof args.work_id === "string" ? args.work_id : undefined;
      const result = await service.buildContextPack(args);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      const verbose = args.verbose === true;

      // When include_content is requested AND we have repo access, resolve
      // each item to its full body in parallel. Without deps we silently
      // fall back to the snippet-only shape — the tool stays usable in
      // test contexts or reduced wiring without surprising the caller.
      const contentById = includeContent && deps
        ? await loadContentForPack(result.value.items, deps)
        : new Map<string, string>();

      const withContent = <T extends { id: string }>(item: T): T & { content?: string } => {
        if (!includeContent) return item;
        const content = contentById.get(item.id);
        return content !== undefined ? { ...item, content } : item;
      };

      const snapshotInfo = await loadSnapshotForPack({ agentId, workId }, deps);
      const extraGuidance = snapshotInfo?.stale
        ? ["stale_snapshot: the attached environment snapshot is older than the configured max age; re-capture before trusting cwd, lockfile, or runtime fields."]
        : [];

      if (verbose) {
        return successResponse({
          ...result.value,
          guidance: [...result.value.guidance, ...extraGuidance],
          items: result.value.items.map(withContent),
          ...(snapshotInfo !== null && { snapshot: snapshotInfo }),
        });
      }
      // Slim response: strip diagnostics, reason, searchScore, sourcePath, references
      const slimItems = result.value.items.map((item) => withContent({
        id: item.id,
        title: item.title,
        type: item.type,
        score: item.score,
        snippet: item.snippet,
        updatedAt: item.updatedAt,
        ...(item.category !== undefined && { category: item.category }),
        ...(item.template !== undefined && { template: item.template }),
        ...(item.phase !== undefined && { phase: item.phase }),
        codeRefs: item.codeRefs,
        ...(item.staleCodeRefs.length > 0 && { staleCodeRefs: item.staleCodeRefs }),
      }));
      return successResponse({
        query: result.value.query,
        mode: result.value.mode,
        summary: result.value.summary,
        guidance: [...result.value.guidance, ...extraGuidance],
        items: slimItems,
        ...(snapshotInfo !== null && { snapshot: snapshotInfo }),
      });
    }
    case "index_article": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const source = requireString(args, "source");
      if (isErrorResponse(source)) return source;
      const sourceErr = requireEnum(source, VALID_SOURCES, "source");
      if (sourceErr) return sourceErr;
      const result =
        source === "knowledge"
          ? await service.indexKnowledgeArticle(id)
          : await service.indexWorkArticle(id);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse({ indexed: true });
    }
    case "remove_from_index": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const result = await service.removeArticle(id);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse({ removed: true });
    }
    case "reindex_all": {
      const result = await service.fullReindex();
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
