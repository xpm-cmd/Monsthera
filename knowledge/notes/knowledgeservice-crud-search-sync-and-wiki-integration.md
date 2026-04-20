---
id: k-g7zu4ki4
title: KnowledgeService: CRUD, search sync, and wiki integration
slug: knowledgeservice-crud-search-sync-and-wiki-integration
category: context
tags: [knowledge-service, crud, search-sync, wiki, validation]
codeRefs: [src/knowledge/service.ts, src/knowledge/repository.ts, src/knowledge/file-repository.ts, src/knowledge/schemas.ts, src/knowledge/slug.ts, src/tools/wiki-tools.ts]
references: [wiki-surfaces-and-wikilink-semantics, core-runtime-state-logging-and-startup-bootstrap]
createdAt: 2026-04-11T02:23:56.453Z
updatedAt: 2026-04-18T07:40:31.639Z
---


# KnowledgeService

The `KnowledgeService` class is the central orchestrator for all knowledge article operations. It sits between MCP tool handlers and the underlying repository, coordinating three side-effects on every mutation: repository write, search index sync, and wiki rebuild.

## Dependencies

Constructed via `KnowledgeServiceDeps`:

- **knowledgeRepo** (`KnowledgeArticleRepository`) — persistence layer (filesystem-backed)
- **logger** (`Logger`) — scoped to `{ domain: "knowledge" }`
- **searchSync** (`SearchMutationSync`, optional) — keeps the BM25+semantic search index in sync
- **status** (`StatusReporter`, optional) — records live stats like `knowledgeArticleCount`
- **bookkeeper** (`WikiBookkeeper`, optional) — maintains `knowledge/index.md` and `knowledge/log.md`

## The KnowledgeArticle data model

Defined in `src/knowledge/repository.ts`:

| Field | Type | Notes |
|---|---|---|
| `id` | `ArticleId` (branded string) | Auto-generated UUID via `generateArticleId()` if not provided |
| `title` | `string` | 1-200 chars, validated by Zod |
| `slug` | `Slug` (branded string) | Derived from title via `uniqueSlug()`, used as filename |
| `category` | `string` | 1-100 chars (e.g. `decision`, `context`, `guide`, `solution`, `pattern`, `gotcha`) |
| `content` | `string` | Markdown body, min 1 char |
| `tags` | `readonly string[]` | Free-form tags for discovery and graph edges |
| `codeRefs` | `readonly string[]` | Relative file paths linking the article to source code |
| `references` | `readonly string[]` | IDs or slugs of other articles this one references |
| `sourcePath` | `string?` | Optional path to an external source file (for import tracking) |
| `createdAt` | `string` | ISO timestamp |
| `updatedAt` | `string` | ISO timestamp, refreshed on every update |

## Public methods

### createArticle(input: unknown)

1. **Validate** — runs `validateCreateInput(input)` using `CreateArticleInputSchema` (Zod). Rejects if title, category, or content are missing/invalid.
2. **Persist** — calls `repo.create(validated)`. The file repository generates an ID, computes a unique slug, and writes a markdown file with YAML frontmatter to `knowledge/notes/<slug>.md`.
3. **Search sync** — calls `searchSync.indexKnowledgeArticle(id)` to upsert the article into the BM25+embedding index. Failures are logged as warnings, not thrown.
4. **Status refresh** — re-counts all articles and records `knowledgeArticleCount` via `StatusReporter`.
5. **Wiki log** — appends a `create` entry to `knowledge/log.md` via the bookkeeper.
6. **Wiki index rebuild** — rebuilds `knowledge/index.md` from all knowledge + work articles.

Returns `Result<KnowledgeArticle, ValidationError | StorageError>`.

### updateArticle(id: string, input: unknown)

1. **Validate** — runs `validateUpdateInput(input)` using `UpdateArticleInputSchema`. All fields are optional.
2. **Persist** — calls `repo.update(id, validated)`. If the title changed, the repository computes a new slug and renames the file (deletes old slug file, writes new one). `updatedAt` is always refreshed.
3. **Search sync** — re-indexes the article.
4. **Wiki log** — appends an `update` entry.
5. **Wiki index rebuild** — rebuilds the index.

Note: unlike create, update does NOT call `refreshCounts()` since the count hasn't changed.

Returns `Result<KnowledgeArticle, NotFoundError | ValidationError | StorageError>`.

### deleteArticle(id: string)

1. **Capture title** — reads the article before deletion so the title can be logged.
2. **Persist** — calls `repo.delete(id)`, which removes the markdown file.
3. **Search removal** — calls `searchSync.removeArticle(id)` to purge from the index.
4. **Status refresh** — re-counts articles.
5. **Wiki log** — appends a `delete` entry.
6. **Wiki index rebuild** — rebuilds the index.

Returns `Result<void, NotFoundError | StorageError>`.

### getArticle(id: string)

Direct pass-through to `repo.findById(id)`. No side-effects.

### getArticleBySlug(slugValue: string)

Calls `repo.findBySlug(brandSlug(slugValue))`. The file repository reads directly from `knowledge/notes/<slug>.md` — O(1) file read, no directory scan.

### listArticles(category?: string)

If `category` is provided, delegates to `repo.findByCategory(category)` which loads all articles and filters by case-insensitive category match. Otherwise calls `repo.findMany()` to return all articles.

### searchArticles(query: string)

Validates the query is non-empty, then delegates to `repo.search(query)`. The file repository performs a case-insensitive substring match across title, content, category, and tags. This is the repository-level fallback search — the primary search path goes through the hybrid BM25+semantic search service directly.

## The three side-effects pattern

Every mutation method follows the same sequence:

```
validate input (Zod)
  → repo write (filesystem)
    → search sync (index upsert/remove)
      → status refresh (article count)
        → bookkeeper log (append to log.md)
          → wiki index rebuild (rewrite index.md)
```

Search sync and bookkeeper failures are caught and logged as warnings — they never fail the primary operation. This makes the system eventually consistent: a search index can be rebuilt later via `reindex_all`.

## Cross-wiring pattern: setWorkRepo()

The wiki index (`knowledge/index.md`) lists both knowledge articles AND work articles. But `KnowledgeService` only has access to the knowledge repository. To solve this circular dependency:

1. The DI container creates both `KnowledgeService` and `WorkService` independently.
2. After construction, the container calls `knowledgeService.setWorkRepo(workRepo)` to inject a reference to the work repository.
3. The `rebuildIndex()` method uses `this._workRepoRef.findMany()` alongside `this.repo.findMany()` to gather both article sets for the bookkeeper.

If `setWorkRepo()` was never called (i.e. `_workRepoRef` is undefined), `rebuildIndex()` silently skips — no crash.

## Slug generation

Defined in `src/knowledge/slug.ts`:

- **`toSlug(title)`** — converts a title to kebab-case: lowercase, spaces/underscores to hyphens, strip non-alphanumeric, collapse consecutive hyphens, trim edges. Falls back to `"untitled"` if the result is empty.
- **`uniqueSlug(title, existingSlugs)`** — calls `toSlug()`, then if the slug collides, appends `-2`, `-3`, etc. until unique.

The slug is used as the markdown filename (`<slug>.md`) and as a stable identifier for `findBySlug()`.

## Zod validation schemas

Defined in `src/knowledge/schemas.ts`:

- **`CreateArticleInputSchema`** — requires `title` (1-200), `category` (1-100), `content` (min 1). Optional: `tags`, `codeRefs`, `references` (all default to `[]`).
- **`UpdateArticleInputSchema`** — all fields optional with same constraints.
- **`ArticleFrontmatterSchema`** — validates YAML frontmatter when reading markdown files from disk. Includes `id`, `slug`, timestamps, and all metadata arrays.

Each schema has a corresponding `validate*()` function that returns a `Result<T, ValidationError>` with Zod issue details on failure.

## Filesystem repository (FileSystemKnowledgeArticleRepository)

Articles are stored as markdown files in `knowledge/notes/<slug>.md` with YAML frontmatter containing all metadata fields. The repository:

- **Reads** by parsing frontmatter + body via `parseMarkdown()` and validating frontmatter via `validateFrontmatter()`.
- **Writes** by serializing frontmatter + body via `serializeMarkdown()`.
- **Lists** by scanning the `notes/` directory for `.md` files.
- **Searches** by loading all articles and filtering with case-insensitive substring matching.
- **Updates** write the new file first, then delete the old slug file if the slug changed (safe rename).
- **Ensures** the `notes/` directory exists before any write operation.

<!-- codex-related-articles:start -->
## Related Articles

- [[wiki-surfaces-and-wikilink-semantics]]
- [[core-runtime-state-logging-and-startup-bootstrap]]
- [[structureservice-code-reference-validation-and-graph-analysis]]
<!-- codex-related-articles:end -->
