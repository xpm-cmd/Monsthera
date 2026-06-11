import type { KnowledgeService } from "../knowledge/service.js";
import type { StructureService, NeighborResult } from "../structure/service.js";
import { successResponse, errorResponse, requireString, optionalString, optionalNumber, isErrorResponse, MAX_QUERY_LENGTH, MAX_TITLE_LENGTH } from "./validation.js";
import { applyTagDelta } from "../knowledge/tags.js";
import { parseCustomFilter, matchesCustomFilter, type CustomFilter } from "../knowledge/custom-filter.js";

/** MCP tool definition shape */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** MCP tool response shape (compatible with MCP SDK CallToolResult) */
export interface ToolResponse {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Maximum number of articles accepted by batch_create_articles / batch_update_articles. */
export const MAX_BATCH_ARTICLES = 100;

/**
 * Coerce an optional MCP `args` value to a string array for the incremental
 * tag ops: `undefined` → `[]`; a non-array or array containing a non-string →
 * `null` so the caller can return a VALIDATION_FAILED response.
 */
function toStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) return null;
  return value as string[];
}

/** Returns the knowledge tool definitions for MCP ListTools */
export function knowledgeToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "create_article",
      description: "Create a reusable knowledge article when a decision, guide, imported source, or implementation pattern should remain available for later agents. Search sync happens automatically; use reindex_all only after bulk imports or recovery work. Slug is auto-generated from title by default; call `preview_slug` first and/or pass an explicit `slug` for nontrivial titles to avoid cross-link drift. When to use: capture a decision, root cause, or pattern the moment it crystallizes mid-task; for many articles at once prefer batch_create_articles, and for existing files on disk prefer ingest_local_sources.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Article title" },
          category: { type: "string", description: "Article category" },
          content: { type: "string", description: "Article content (markdown)" },
          tags: { type: "array", items: { type: "string" }, description: "Tags" },
          codeRefs: { type: "array", items: { type: "string" }, description: "Code references" },
          references: { type: "array", items: { type: "string" }, description: "References to other articles (IDs or slugs)" },
          slug: { type: "string", description: "Optional explicit slug. If omitted, auto-generated from title. Call preview_slug first for nontrivial titles." },
          extraFrontmatter: { type: "object", description: "ADR-020: typed/custom frontmatter fields (e.g. { origin: \"human\", ticket: \"ABC-123\" }). Persisted and round-tripped verbatim alongside the standard fields." },
        },
        required: ["title", "category", "content"],
      },
    },
    {
      name: "preview_slug",
      description: "Preview the slug that would be auto-generated for a given article title. Read-only: reports the deterministic slug, whether that slug already exists, and any near-miss conflicts (Jaccard similarity >= 0.7 on hyphen-split tokens) that sibling articles may have authored wikilinks against. Call before create_article for nontrivial titles so cross-links do not silently drift. When to use: just before create_article when the title is long, punctuated, or likely to be wikilinked by other articles; skip it for short unambiguous titles.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Article title to evaluate" },
        },
        required: ["title"],
      },
    },
    {
      name: "get_article",
      description: "Open a specific knowledge article by ID or slug after search, context-pack selection, or work references point to it. When to use: when you hold one specific id or slug and need the full body plus graph connections; to fetch many ids from a ranked result list, prefer batch_get_articles.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Article ID" },
          slug: { type: "string", description: "Article slug" },
        },
      },
    },
    {
      name: "update_article",
      description: "Update an existing knowledge article as understanding improves. Add durable wording, code refs, and reusable conclusions instead of leaving them only in chat or work history. Search sync happens automatically; manual reindex is not needed for normal edits. Pass `new_slug` to atomically rename the article and fix every incoming reference in one operation. When to use: when new findings refine or extend an existing article — prefer this over creating a near-duplicate; for the same edit across many articles, prefer batch_update_articles.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Article ID (required)" },
          title: { type: "string", description: "New title" },
          category: { type: "string", description: "New category" },
          content: { type: "string", description: "New content" },
          tags: { type: "array", items: { type: "string" }, description: "New tags (full replace). Mutually exclusive with add_tags/remove_tags." },
          add_tags: { type: "array", items: { type: "string" }, description: "Tags to add to the existing set (normalized + deduped). Mutually exclusive with `tags`." },
          remove_tags: { type: "array", items: { type: "string" }, description: "Tags to remove from the existing set (case-insensitive). Mutually exclusive with `tags`." },
          codeRefs: { type: "array", items: { type: "string" }, description: "New code refs" },
          references: { type: "array", items: { type: "string" }, description: "References to other articles (IDs or slugs)" },
          new_slug: { type: "string", description: "Optional: rename the article's slug. Collision-checked. All incoming references in other articles' `references` arrays are updated automatically. Use `rewrite_inline_wikilinks: true` to also update inline `[[old-slug]]` wikilinks in bodies." },
          rewrite_inline_wikilinks: { type: "boolean", description: "When renaming via `new_slug`, also rewrite `[[old-slug]]` / `[[old-slug|display]]` / `[[old-slug#anchor]]` wikilinks in other articles' bodies (display text and anchors preserved). Default false — body content changes are opt-in." },
          extraFrontmatter: { type: "object", description: "ADR-020: typed/custom frontmatter fields. Replaces the article's prior custom-frontmatter map when supplied." },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_article",
      description: "Delete a knowledge article by ID. Search sync happens automatically; manual remove_from_index is only for repair flows. When to use: when an article is obsolete or duplicates a better one; if the content is merely outdated, prefer update_article so incoming references keep resolving.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Article ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_articles",
      description: "List knowledge articles with optional AND-combined filters. Returns summaries (no content) with pagination; use get_article (or batch_get_articles for many) to read full content. Filters: `category`, `tag` (single tag; matches if the article carries it), `hasCodeRefs` (true = articles grounded in code, false = prose-only), `filter` (custom-frontmatter `custom.<key><op><value>`, ADR-020). When to use: when browsing or auditing by category, tag, code-ref presence, or frontmatter field rather than by topic; for topical lookups, prefer search_articles or build_context_pack.",
      inputSchema: {
        type: "object" as const,
        properties: {
          category: { type: "string", description: "Filter by category" },
          tag: { type: "string", description: "Filter by a single tag (article must carry it)" },
          hasCodeRefs: {
            type: "boolean",
            description: "Filter by presence of code references — true returns only articles with at least one codeRef, false returns only prose-only articles",
          },
          filter: {
            type: "string",
            description: "Custom-frontmatter filter `custom.<key><op><value>` where <op> is one of =, <, <=, >, >=. Equality is string-based; comparisons are numeric. Only scalar fields are filterable — objects/arrays never match (ADR-020/ADR-012). e.g. `custom.replicability_score<0.8` or `custom.origin=human`.",
          },
          limit: { type: "number", description: "Max results (1-100, default 20)" },
          offset: { type: "number", description: "Skip N results (default 0)" },
        },
      },
    },
    {
      name: "search_articles",
      description: "Search knowledge articles by query string. Use this for a knowledge-only lookup; use search or build_context_pack when the task may span both work and knowledge. When to use: quick knowledge-only lookups where ranked summaries are enough — prior decisions, finding an article id; before coding or deep investigation, prefer build_context_pack.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Maximum results (1-50, default 10)" },
          offset: { type: "number", description: "Skip N results (default 0)" },
        },
        required: ["query"],
      },
    },
    {
      name: "batch_create_articles",
      description: `Create many knowledge articles in a single call. Best-effort: each entry is validated and created independently, and the response reports per-item success or failure without aborting the batch. Accepts 1-${MAX_BATCH_ARTICLES} entries using the same schema as create_article. Search sync runs per-item; wiki index.md is rebuilt once at the end. Use for bulk imports or migrations; for a single article, prefer create_article. When to use: when an import, migration, or distillation step yields several ready articles in one sitting; one or two articles do not justify the batch.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          articles: {
            type: "array",
            description: `Array of 1-${MAX_BATCH_ARTICLES} article create inputs (same shape as create_article).`,
            items: {
              type: "object",
              properties: {
                title: { type: "string", description: "Article title" },
                category: { type: "string", description: "Article category" },
                content: { type: "string", description: "Article content (markdown)" },
                tags: { type: "array", items: { type: "string" } },
                codeRefs: { type: "array", items: { type: "string" } },
                references: { type: "array", items: { type: "string" } },
                slug: { type: "string", description: "Optional explicit slug" },
              },
              required: ["title", "category", "content"],
            },
          },
        },
        required: ["articles"],
      },
    },
    {
      name: "batch_get_articles",
      description: `Fetch many knowledge articles by id in a single call. Best-effort: each id is resolved independently and the response reports per-item success or failure in the requested order. Accepts 1-${MAX_BATCH_ARTICLES} ids. Designed as the natural follow-up to build_context_pack / search — send the ids from the ranked results instead of calling get_article N times. For a single article, prefer get_article (which also returns graph connections). When to use: right after a ranked search or context pack returns multiple promising ids and you need every body before deciding; skip it when the pack was built with include_content, which already inlines them.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          ids: {
            type: "array",
            description: `Array of 1-${MAX_BATCH_ARTICLES} knowledge article ids.`,
            items: { type: "string" },
          },
        },
        required: ["ids"],
      },
    },
    {
      name: "batch_update_articles",
      description: `Update many knowledge articles in a single call. Best-effort: each entry is validated and applied independently, and the response reports per-item success or failure. Accepts 1-${MAX_BATCH_ARTICLES} entries; each requires \`id\` plus any subset of update_article fields (including \`new_slug\` and \`rewrite_inline_wikilinks\`). Rename semantics match update_article — per-item collision checks and referrer updates still apply. Use for bulk edits, migrations, or citation backfills; for a single article, prefer update_article. When to use: when one logical change must land across many articles at once — tag sweeps, citation backfills, slug migrations — rather than looping update_article per id.`,
      inputSchema: {
        type: "object" as const,
        properties: {
          updates: {
            type: "array",
            description: `Array of 1-${MAX_BATCH_ARTICLES} update entries. Each entry requires \`id\` and accepts the same optional fields as update_article.`,
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Article ID (required)" },
                title: { type: "string" },
                category: { type: "string" },
                content: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                codeRefs: { type: "array", items: { type: "string" } },
                references: { type: "array", items: { type: "string" } },
                new_slug: { type: "string" },
                rewrite_inline_wikilinks: { type: "boolean" },
              },
              required: ["id"],
            },
          },
        },
        required: ["updates"],
      },
    },
  ];
}

function formatConnections(neighbors: NeighborResult): Record<string, unknown> {
  const references: { id: string; title: string; kind: string }[] = [];
  const referencedBy: { id: string; title: string; kind: string }[] = [];
  const sharedTopics: { id: string; title: string; sharedTags: readonly string[] }[] = [];
  const codeLinks: string[] = [];

  for (const edge of neighbors.edges) {
    if (edge.neighborKind === "code") {
      codeLinks.push(edge.neighborId);
      continue;
    }
    const entry = { id: edge.neighborId, title: edge.neighborLabel, kind: edge.neighborKind };
    if (edge.kind === "reference" && edge.direction === "outgoing") {
      references.push(entry);
    } else if (edge.kind === "reference" && edge.direction === "incoming") {
      referencedBy.push(entry);
    } else if (edge.kind === "shared_tag") {
      sharedTopics.push({ id: edge.neighborId, title: edge.neighborLabel, sharedTags: edge.tags ?? [] });
    } else if (edge.kind === "dependency") {
      referencedBy.push(entry);
    }
  }

  return {
    ...(references.length > 0 ? { references } : {}),
    ...(referencedBy.length > 0 ? { referencedBy } : {}),
    ...(sharedTopics.length > 0 ? { sharedTopics } : {}),
    ...(codeLinks.length > 0 ? { codeLinks } : {}),
  };
}

/** Handle a knowledge tool call */
export async function handleKnowledgeTool(
  name: string,
  args: Record<string, unknown>,
  service: KnowledgeService,
  structureService?: StructureService,
): Promise<ToolResponse> {
  switch (name) {
    case "create_article": {
      // args passed directly to service — Zod validates inside service.createArticle
      const result = await service.createArticle(args);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "get_article": {
      const id = optionalString(args, "id");
      if (isErrorResponse(id)) return id;
      const slug = optionalString(args, "slug");
      if (isErrorResponse(slug)) return slug;
      if (!id && !slug) {
        return errorResponse("VALIDATION_FAILED", "Either id or slug is required");
      }
      const result = id
        ? await service.getArticle(id)
        : await service.getArticleBySlug(slug!);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      if (structureService) {
        const neighbors = await structureService.getNeighbors(result.value.id, { limit: 10 });
        if (neighbors.ok) {
          const connections = formatConnections(neighbors.value);
          if (Object.keys(connections).length > 0) {
            return successResponse({ ...result.value, connections });
          }
        }
      }
      return successResponse(result.value);
    }
    case "update_article": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      // Destructure the incremental tag ops OUT before the spread: the service's
      // Zod schema would silently strip unknown keys, so add_tags/remove_tags
      // must be resolved here into a concrete `tags` array.
      const { id: _id, add_tags, remove_tags, ...updateFields } = args;
      const wantsDelta = add_tags !== undefined || remove_tags !== undefined;
      if (wantsDelta && updateFields.tags !== undefined) {
        return errorResponse(
          "VALIDATION_FAILED",
          "Use `tags` (full replace) or `add_tags`/`remove_tags` (incremental), not both.",
        );
      }
      if (wantsDelta) {
        const add = toStringArray(add_tags);
        const remove = toStringArray(remove_tags);
        if (add === null || remove === null) {
          return errorResponse("VALIDATION_FAILED", "`add_tags` and `remove_tags` must be arrays of strings");
        }
        const current = await service.getArticle(id);
        if (!current.ok) return errorResponse(current.error.code, current.error.message);
        updateFields.tags = applyTagDelta(current.value.tags, add, remove);
      }
      const result = await service.updateArticle(id, updateFields);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse(result.value);
    }
    case "delete_article": {
      const id = requireString(args, "id");
      if (isErrorResponse(id)) return id;
      const result = await service.deleteArticle(id);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse({ deleted: true });
    }
    case "list_articles": {
      const category = optionalString(args, "category");
      if (isErrorResponse(category)) return category;
      const tag = optionalString(args, "tag");
      if (isErrorResponse(tag)) return tag;
      let hasCodeRefs: boolean | undefined;
      if (args.hasCodeRefs !== undefined) {
        if (typeof args.hasCodeRefs !== "boolean") {
          return errorResponse("VALIDATION_FAILED", `"hasCodeRefs" must be a boolean`);
        }
        hasCodeRefs = args.hasCodeRefs;
      }
      let customFilter: CustomFilter | undefined;
      if (args.filter !== undefined) {
        if (typeof args.filter !== "string") {
          return errorResponse("VALIDATION_FAILED", `"filter" must be a string`);
        }
        const parsed = parseCustomFilter(args.filter);
        if (!parsed.ok) return errorResponse("VALIDATION_FAILED", parsed.error);
        customFilter = parsed.value;
      }
      const rawLimit = typeof args.limit === "number" ? args.limit : 20;
      const limit = Math.max(1, Math.min(rawLimit, 100));
      const rawOffset = typeof args.offset === "number" ? args.offset : 0;
      const offset = Math.max(0, rawOffset);
      const result = await service.listArticles(category);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);

      // AND-combined in-memory filters layered on top of the repo-level
      // category filter, so agents can mix criteria without per-combination
      // repo methods.
      const filtered = result.value.filter((a) => {
        if (tag !== undefined && !a.tags.includes(tag)) return false;
        if (hasCodeRefs === true && a.codeRefs.length === 0) return false;
        if (hasCodeRefs === false && a.codeRefs.length > 0) return false;
        if (customFilter !== undefined && !matchesCustomFilter(a.extraFrontmatter, customFilter)) return false;
        return true;
      });
      const total = filtered.length;
      const page = filtered.slice(offset, offset + limit);
      const summaries = page.map((a) => ({
        id: a.id,
        title: a.title,
        slug: a.slug,
        category: a.category,
        tags: a.tags,
        updatedAt: a.updatedAt,
      }));
      return successResponse({ total, limit, offset, items: summaries });
    }
    case "preview_slug": {
      const title = requireString(args, "title", MAX_TITLE_LENGTH);
      if (isErrorResponse(title)) return title;
      const result = await service.previewSlug(title);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      return successResponse({
        slug: result.value.slug,
        already_exists: result.value.alreadyExists,
        conflicts: result.value.conflicts,
      });
    }
    case "batch_create_articles": {
      const arr = args.articles;
      if (!Array.isArray(arr)) {
        return errorResponse("VALIDATION_FAILED", '"articles" is required and must be an array');
      }
      if (arr.length === 0) {
        return errorResponse("VALIDATION_FAILED", '"articles" must not be empty');
      }
      if (arr.length > MAX_BATCH_ARTICLES) {
        return errorResponse(
          "VALIDATION_FAILED",
          `"articles" accepts at most ${MAX_BATCH_ARTICLES} entries per call (received ${arr.length})`,
        );
      }
      const result = await service.batchCreateArticles(arr);
      return successResponse(result);
    }
    case "batch_update_articles": {
      const arr = args.updates;
      if (!Array.isArray(arr)) {
        return errorResponse("VALIDATION_FAILED", '"updates" is required and must be an array');
      }
      if (arr.length === 0) {
        return errorResponse("VALIDATION_FAILED", '"updates" must not be empty');
      }
      if (arr.length > MAX_BATCH_ARTICLES) {
        return errorResponse(
          "VALIDATION_FAILED",
          `"updates" accepts at most ${MAX_BATCH_ARTICLES} entries per call (received ${arr.length})`,
        );
      }
      const result = await service.batchUpdateArticles(arr);
      return successResponse(result);
    }
    case "batch_get_articles": {
      const arr = args.ids;
      if (!Array.isArray(arr)) {
        return errorResponse("VALIDATION_FAILED", '"ids" is required and must be an array');
      }
      if (arr.length === 0) {
        return errorResponse("VALIDATION_FAILED", '"ids" must not be empty');
      }
      if (arr.length > MAX_BATCH_ARTICLES) {
        return errorResponse(
          "VALIDATION_FAILED",
          `"ids" accepts at most ${MAX_BATCH_ARTICLES} entries per call (received ${arr.length})`,
        );
      }
      const result = await service.batchGetArticles(arr);
      return successResponse(result);
    }
    case "search_articles": {
      const query = requireString(args, "query", MAX_QUERY_LENGTH);
      if (isErrorResponse(query)) return query;
      const limitArg = optionalNumber(args, "limit", 1, 50);
      if (isErrorResponse(limitArg)) return limitArg;
      const offsetArg = optionalNumber(args, "offset", 0, 10000);
      if (isErrorResponse(offsetArg)) return offsetArg;
      const limit = limitArg ?? 10;
      const offset = offsetArg ?? 0;
      const result = await service.searchArticles(query);
      if (!result.ok) return errorResponse(result.error.code, result.error.message);
      const page = result.value.slice(offset, offset + limit);
      const summaries = page.map((a) => ({
        id: a.id,
        title: a.title,
        slug: a.slug,
        category: a.category,
        tags: a.tags,
        codeRefs: a.codeRefs,
        references: a.references,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        snippet: a.content.slice(0, 200),
      }));
      return successResponse(summaries);
    }
    default:
      return errorResponse("NOT_FOUND", `Unknown tool: ${name}`);
  }
}
