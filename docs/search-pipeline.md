# Search Pipeline

Agora uses two FTS5-backed search subsystems: one for **code files** and one for **knowledge entries**. Both operate locally via SQLite with no external dependencies. Semantic search enhances results when the ONNX model is available but is never required.

## Code Search (`get_code_pack`)

### Query Construction

Multi-word queries use **AND semantics** — all terms must match for a file to rank:

```
"optimization node scipy"  →  "optimization" AND "node" AND "scipy"
```

Terms shorter than 2 characters or containing FTS5 operators are filtered out. The sanitizer strips punctuation and wraps each remaining token in double quotes.

### FTS5 Table: `files_fts`

Columns: `path`, `summary`, `symbols`

BM25 column weights:

| Column   | Weight | Rationale |
|----------|--------|-----------|
| path     | 1.5×   | File paths carry signal but shouldn't dominate |
| summary  | 1.0×   | Natural-language description of the file |
| symbols  | 2.0×   | Function/class names are high-value matches |

### Score Penalties

Two post-BM25 penalties demote low-value results:

| Penalty | Factor | Applies to |
|---------|--------|------------|
| Test file | 0.7× | Files matching `test/`, `spec/`, `.test.`, `.spec.` when query doesn't contain "test" |
| Config file | 0.5× | Files matching `tsconfig*`, `.eslintrc*`, `vite.config*`, `webpack*`, `jest.config*`, `package.json`, `.prettierrc*`, `.babelrc*`, `rollup.config*` |

### Scope Filtering

The `scope` parameter restricts results to a path prefix:

- **FTS5**: `WHERE path LIKE 'prefix%'` in SQL
- **Zoekt**: `f:^prefix` regex filter
- **Vector search**: Post-filter on returned paths

### Hybrid Merge (when semantic model available)

```
FTS5 results (keyword)  ─┐
                          ├──► merge(alpha=0.5) ──► final ranking
Vector results (semantic) ─┘
```

- Files found by **both** sources: `score = 0.5 × semanticScore + 0.5 × fts5Score`
- Files found by **FTS5 only**: `score = fts5Score × 0.5` (penalized — no semantic signal)
- Files found by **vector only**: `score = semanticScore × 0.5` (the hybrid win — discovered without keyword overlap)

## Knowledge Search (`search_knowledge`)

### FTS5 Table: `knowledge_fts`

Virtual table created at server startup for both repo and global databases. Rebuilt after every `store_knowledge`, `archive_knowledge`, and `delete_knowledge` call.

Columns: `knowledge_id` (UNINDEXED), `title`, `content`, `type` (UNINDEXED), `tags`

BM25 column weights:

| Column  | Weight | Rationale |
|---------|--------|-----------|
| title   | 3.0×   | Titles are concise identifiers — exact match is high signal |
| content | 1.0×   | Full text body |
| tags    | 2.0×   | Tag matches indicate topical relevance |

### Search Strategy

```
Query ──► FTS5 knowledge_fts (always available)
              │
              ├── if semantic model loaded ──► blend FTS5 + vector scores
              │                                 (alpha=0.5)
              │
              └── return FTS5 results ranked by BM25
```

**Key design decision**: FTS5 is the primary search path, not a fallback. This ensures `search_knowledge` returns results even when `semanticEnabled: false` in config. Semantic search enhances ranking when available but never gates result availability.

### Type Filtering

When `type` parameter is provided, FTS5 filters at query time:

```sql
SELECT ... FROM knowledge_fts WHERE knowledge_fts MATCH ? AND type = ?
```

## Embedding Model

- **Model**: Xenova/all-MiniLM-L6-v2 (ONNX quantized q8)
- **Dimensions**: 384 float32
- **Pooling**: Mean across sequence length, L2 normalized
- **Storage**: BLOB column in SQLite (`files.embedding`, `knowledge.embedding`)
- **Loading**: Lazy — initialized on first use, memoized

## Evidence Bundles

Search results feed into the evidence bundle pipeline:

1. **Stage A** — Top 5 candidates: path + symbols + score + summary
2. **Stage B** — Top 3 expanded with: code spans (200 lines max), related commits, linked notes, secret detection
3. **Bundle ID** — SHA-256 of `query + commit + sorted paths` = deterministic, cacheable
