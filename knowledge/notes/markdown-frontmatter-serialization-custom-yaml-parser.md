---
id: k-zj0lp1yv
title: Markdown Frontmatter Serialization: Custom YAML Parser
slug: markdown-frontmatter-serialization-custom-yaml-parser
category: context
tags: [markdown, serialization, frontmatter, yaml, parser, storage]
codeRefs: [src/knowledge/markdown.ts, src/knowledge/file-repository.ts, src/work/file-repository.ts]
references: [k-acodv9lb]
createdAt: 2026-04-11T02:14:49.615Z
updatedAt: 2026-04-11T02:14:49.615Z
---

## Overview

Monsthera uses a **custom, zero-dependency YAML frontmatter parser** rather than a library like `js-yaml` or `gray-matter`. The implementation lives in `src/knowledge/markdown.ts` and handles both parsing and serialization of the `---`-delimited frontmatter + body format used by all knowledge and work articles.

## Why This Matters

This is a critical path — every article read and write goes through these two functions. Understanding the parser's limitations prevents subtle bugs when authoring articles.

## parseMarkdown(raw) — Reading

The parser:
1. Normalizes line endings (CRLF to LF).
2. Finds the opening `---\n` at position 0 and the closing `\n---\n` delimiter.
3. Splits the YAML block from the body (stripping the conventional blank line after `---`).
4. Parses YAML key-value pairs line by line using simple heuristics.

### Value type detection (in order):
- **Inline arrays**: `[a, b, c]` becomes `["a", "b", "c"]` — split by comma, trimmed.
- **Quoted strings**: `"foo"` or `'foo'` — quotes stripped.
- **Booleans**: literal `true` / `false`.
- **Numbers**: any string that passes `!isNaN(Number(s))`.
- **Plain strings**: everything else.

### Block-style YAML lists:
```yaml
tags:
  - tag1
  - tag2
```
These are detected by the regex `/^[ \t]+-[ \t]+(.*)$/` when a `currentKey` is active. Items are pushed into an array under the current key.

### Limitations to know:
- **No nested objects** — the parser only handles flat key-value pairs. Complex structures like `enrichmentRolesJson` and `reviewersJson` in work articles are stored as **JSON strings** in the frontmatter and parsed separately with `JSON.parse()` in `FileSystemWorkArticleRepository`.
- **No multi-line string values** — no support for YAML `|` or `>` block scalars. All multi-line content goes in the body, not frontmatter.
- **Empty values** — a key with no value (e.g., `sourcePath:`) results in an empty string `""`, not `undefined`.

## serializeMarkdown(frontmatter, body) — Writing

The serializer is simpler:
1. Opens with `---`.
2. For each key-value pair: arrays become `key: [a, b, c]` (inline format), everything else becomes `key: value`.
3. Closes with `---`, a blank line, then the body.

### Notable behavior:
- Arrays are always serialized inline (`[a, b, c]`), never as block lists. The parser handles both, so round-tripping is safe, but files will always be rewritten in inline format.
- No quoting is applied to string values. If a value contains characters like `:` or `[`, it will be written as-is and re-parsed correctly only if the colon is not at a key-position. This has not caused issues in practice because frontmatter values are typically simple strings, IDs, or timestamps.

## Work Article JSON Embedding

`FileSystemWorkArticleRepository` stores complex nested data (enrichment roles, reviewers, phase history) as JSON strings in frontmatter fields named `enrichmentRolesJson`, `reviewersJson`, and `phaseHistoryJson`. These are serialized with `JSON.stringify({ items: [...] })` on write and parsed with a defensive `parseJsonArray()` helper on read that handles both raw arrays and `{ items: [...] }` wrappers, falling back to defaults on parse failure.