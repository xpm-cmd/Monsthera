---
id: k-wntxpu85
title: Monsthera: Ingest Service for Local File Import
slug: monsthera-ingest-service-for-local-file-import
category: context
tags: [ingest, local-import, knowledge-articles, summary-mode, monsthera-v3]
codeRefs: [src/ingest/service.ts, src/ingest/schemas.ts, src/knowledge/markdown.ts]
references: [k-g0buqcg5]
createdAt: 2026-04-11T02:16:31.631Z
updatedAt: 2026-04-11T02:16:31.631Z
---

## Overview

The `IngestService` (`src/ingest/service.ts`) imports local files into Monsthera's knowledge base as knowledge articles. It converts markdown, text, and related files from any directory into indexed, searchable knowledge articles with automatic metadata extraction.

## Input Schema

Validated via Zod in `src/ingest/schemas.ts`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sourcePath` | `string` (required) | — | File or directory path (absolute or relative to repo root) |
| `category` | `string?` | inferred | Override category for all imported articles |
| `tags` | `string[]` | `[]` | Additional tags merged into each article |
| `codeRefs` | `string[]` | `[]` | Additional code refs merged into each article |
| `mode` | `"raw" \| "summary"` | `"raw"` | Import mode |
| `recursive` | `boolean` | `true` | Scan subdirectories |
| `replaceExisting` | `boolean` | `true` | Update articles that share the same `sourcePath` |

## Import Flow

1. **Path resolution** — relative paths resolved against repo root; absolute paths used as-is
2. **File collection** — single file or recursive directory scan
3. **Filtering** — only `.md`, `.markdown`, `.txt`, `.text` extensions; skips `.git`, `node_modules`, `dist`, `.monsthera`, and `knowledge/` directories
4. **Deduplication** — loads all existing knowledge articles and builds a `sourcePath` lookup map; if `replaceExisting` is true, matching articles are updated instead of duplicated
5. **Per-file processing**:
   - Reads file content
   - Attempts to parse frontmatter (falls back to treating entire content as body)
   - Extracts title: frontmatter `title` > first `# heading` > humanized filename
   - Determines category: override > frontmatter `category` > top-level directory name > `"imported"`
   - Merges tags from overrides, frontmatter, and mode (`"summary"` adds a `summary` tag); always adds `"imported"`
   - Auto-extracts code refs from content via regex (`PATH_REF_RE`), verified against filesystem existence
   - Builds content based on mode
6. **Search sync** — each created/updated article is immediately indexed via `SearchMutationSync`
7. **Status update** — refreshes `knowledgeArticleCount` and `lastIngestAt` stats

## Import Modes

### Raw mode
The file content (minus frontmatter) is used as the article body verbatim.

### Summary mode
Builds structured content with these sections:
- **Source** — original path and mode indicator
- **Summary** — first paragraph >= 40 chars, truncated to 420 chars; strips markdown formatting
- **Key points** — up to 5 bullet points or sentences >= 10 chars from the content
- **Important headings** — up to 6 headings from the source (excluding the title itself)
- **Code references** — any auto-extracted code refs
- **Import note** — standard disclaimer about normalization

Summary mode is designed for large design docs or specs where the full content would be too noisy for search ranking.

## Code Ref Extraction

The `PATH_REF_RE` regex matches common project file patterns in content:
- Standard files: `README.md`, `package.json`, `tsconfig.json`, etc.
- Source paths: `src/**/*.ts`, `public/**`, `tests/**`, `scripts/**`, `docs/**`, `knowledge/**`

Each candidate is verified against the filesystem before being included as a code ref. This ensures only valid, existing file paths are recorded.

## Batch Result

Returns `IngestBatchResult` with:
- `importedAt` — timestamp
- `sourcePath` — normalized source path
- `mode` — raw or summary
- `scannedFileCount` — total files found
- `importedCount` — articles created or updated
- `createdCount` / `updatedCount` — breakdown
- `items` — per-file details (articleId, slug, title, category, status, tagCount, codeRefCount)