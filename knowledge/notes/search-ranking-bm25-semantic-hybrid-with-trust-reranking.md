---
id: k-zoawqis5
title: Search Ranking: BM25 + Semantic Hybrid with Trust Reranking
slug: search-ranking-bm25-semantic-hybrid-with-trust-reranking
category: context
tags: [search, bm25, embeddings, ranking, trust, hybrid-search, ollama]
codeRefs: [src/search/service.ts, src/search/embedding.ts, src/search/repository.ts, src/search/schemas.ts, src/core/article-trust.ts, src/core/config.ts]
references: [k-ypsx5ask]
createdAt: 2026-04-11T02:16:11.618Z
updatedAt: 2026-04-11T02:16:11.618Z
---

## How Monsthera Search Ranking Works

Monsthera's `SearchService` (`src/search/service.ts`) implements a three-stage ranking pipeline: BM25 keyword search, semantic similarity via Ollama embeddings, and trust-based reranking.

## Stage 1: BM25 Keyword Search

BM25 always runs first against the inverted index in `SearchIndexRepository`. The query terms are matched against indexed content (article body + code refs joined as a single string). BM25 returns scored results with title, snippet, and type metadata.

Short queries (1-3 terms) use AND semantics; longer queries (4+) use OR with BM25 ranking. CamelCase tokens are split during indexing so "optimization" matches `OptimizationNode`.

The BM25 pass fetches `limit * 3` candidates to give the hybrid merger enough material to work with.

## Stage 2: Semantic Search (Ollama Embeddings)

When `semanticEnabled` is true and the embedding provider has `dimensions > 0` and the index has stored embeddings, the service runs a parallel semantic search:

1. The query string is embedded via `OllamaEmbeddingProvider.embed()` — a POST to `/api/embeddings` on the local Ollama instance
2. The resulting vector is passed to `searchRepo.searchSemantic()` which computes cosine similarity against all stored document embeddings
3. Returns `{ id, score }` pairs where score is cosine similarity in [0, 1]

**Embedding model:** `nomic-embed-text` (768 dimensions) by default, configurable via `config.search.embeddingModel`.

**What gets embedded:** `title + "\n" + content.slice(0, 500)` — a concise representation to keep embedding quality high and cost low.

**Graceful fallback:** If the embedding call fails, the service logs a warning and returns BM25-only results. The `StubEmbeddingProvider` (dimensions=0) disables semantic search entirely without any code path changes.

## Stage 3: Hybrid Merge (Alpha Blending)

The `mergeResults()` method combines BM25 and semantic scores:

```
finalScore = alpha * normalizedBM25 + (1 - alpha) * cosineSimilarity
```

- **alpha** defaults to 0.5 (configured in `config.search.alpha`, range [0, 1])
- **BM25 normalization:** each BM25 score is divided by the maximum BM25 score in the result set, mapping to [0, 1]
- **Cosine similarity** is already in [0, 1]
- Candidates that appear only in semantic results but not in BM25 are **dropped** — BM25 provides the display data (title, snippet)
- Candidates that appear only in BM25 get a cosine score of 0

The merged list is sorted by hybrid score descending.

## Stage 4: Trust Reranking

After hybrid merge, `rerankForTrust()` adjusts scores based on article quality signals:

**For knowledge articles:**
- Legacy migrated articles: **-1.2** penalty (detected by `isLegacyKnowledgeArticle()`)
- Has `sourcePath` (imported from a real file): **+0.45** bonus
- Category is architecture/decision/guide/runbook: **+0.15** bonus

**For work articles:**
- Legacy migrated articles: **-1.1** penalty
- Active phase (planning/implementation/review): **+0.2** bonus

**Legacy query bypass:** If the query itself looks like a legacy lookup (`isLegacyQuery()`), trust reranking is skipped entirely to avoid penalizing intentional legacy searches.

After reranking, results with score <= 0 are filtered out (unless ALL results are <= 0, in which case they're all kept).

## Health Monitoring

The search service maintains a canary health check. After every full reindex, `runCanary()` executes a test query. If the index has documents but the canary returns empty, the subsystem is marked unhealthy. The status reporter exposes index size, embedding count, and canary state.

## Configuration Reference

| Config key | Default | Effect |
|---|---|---|
| `search.semanticEnabled` | `true` | Enable/disable semantic search path |
| `search.embeddingModel` | `"nomic-embed-text"` | Ollama model name |
| `search.alpha` | `0.5` | BM25 vs semantic weight (1.0 = pure BM25) |
| `search.ollamaUrl` | `"http://localhost:11434"` | Ollama API endpoint |
| `search.embeddingProvider` | `"ollama"` | Provider type (only ollama supported) |