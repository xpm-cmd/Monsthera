---
id: k-t27zzmvw
title: Monsthera: Markdown Serialization for Articles
slug: monsthera-markdown-serialization-for-articles
category: context
tags: [markdown-serialization, frontmatter, yaml, knowledge-articles, work-articles, monsthera-v3]
codeRefs: [src/knowledge/markdown.ts, src/work/file-repository.ts, src/knowledge/file-repository.ts]
references: [k-g0buqcg5]
createdAt: 2026-04-11T02:16:09.487Z
updatedAt: 2026-04-11T02:16:09.487Z
---

## Overview

All Monsthera articles (knowledge and work) are persisted as markdown files with YAML frontmatter. The serialization layer lives in `src/knowledge/markdown.ts` and provides two functions: `parseMarkdown()` and `serializeMarkdown()`.

## parseMarkdown(raw: string): Result&lt;ParsedMarkdown, ValidationError&gt;

Parses a raw markdown string into a `ParsedMarkdown` structure containing:
- `frontmatter: Record<string, unknown>` — parsed YAML key-value pairs
- `body: string` — everything after the closing `---` delimiter

### Parsing rules

1. **Line endings** are normalized (CRLF to LF)
2. **Frontmatter delimiters** must be `---` on their own lines; the opening `---` must be the first line
3. **YAML parsing** is a lightweight custom parser (not a full YAML library):
   - `key: value` lines are split on the first colon
   - Values are type-coerced: booleans (`true`/`false`), numbers, quoted strings (single/double), inline arrays (`[a, b, c]`), and plain strings
   - Indented list items (`  - value`) under a key accumulate into an array
   - Empty value after colon starts a list or becomes empty string
4. **Body extraction**: the conventional blank line after `---` is stripped; remaining content is returned as-is

### Limitations

- No nested YAML objects (only flat key-value or key-list)
- No multi-line string values (block scalars)
- Inline arrays are split on commas without quote-awareness (fine for simple tags/IDs)

## serializeMarkdown(frontmatter, body): string

Produces a markdown string from frontmatter and body:

1. Opens with `---`
2. Each frontmatter entry: arrays become inline `[a, b, c]`, scalars become `key: value`
3. Closes with `---`
4. Blank line separator
5. Body content

## How work articles use this for complex fields

Work articles need to store nested objects (enrichment roles, reviewers, phase history) in flat YAML frontmatter. The solution in `src/work/file-repository.ts`:

**Writing**: Complex arrays are serialized as JSON strings in specially-named keys:
```
enrichmentRolesJson: {"items":[...]}
reviewersJson: {"items":[...]}
phaseHistoryJson: {"items":[...]}
```

**Reading**: `parseJsonArray<T>()` parses these JSON strings back, handling both bare arrays and `{ items: T[] }` wrappers. On parse failure, it falls back to template defaults (for enrichment roles) or empty arrays.

This approach keeps the frontmatter human-readable for simple fields while supporting arbitrary nesting for complex structures, without requiring a full YAML parser.

## Knowledge articles

Knowledge articles (`src/knowledge/file-repository.ts`) use the same `parseMarkdown`/`serializeMarkdown` but with simpler frontmatter — all fields are scalars or flat arrays (id, title, slug, category, tags, references, codeRefs, sourcePath, createdAt, updatedAt). No JSON-encoded fields needed.