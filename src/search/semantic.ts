import type { Database as DatabaseType } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { SearchResult } from "./interface.js";
import * as queries from "../db/queries.js";
import { isTestFile } from "./fts5.js";

export interface SemanticRerankerOptions {
  sqlite: DatabaseType;
  db: BetterSQLite3Database<typeof schema>;
  onFallback?: (reason: string) => void;
}

/**
 * Optional semantic re-ranking layer.
 * Uses a local ONNX embedding model to re-rank FTS5/Zoekt search results
 * by semantic similarity to the query.
 */
export class SemanticReranker {
  private pipeline: any | null = null;
  private loading: Promise<boolean> | null = null;
  private available = false;

  constructor(private opts: SemanticRerankerOptions) {}

  /**
   * Lazy-load the transformer model. Returns true if model loaded successfully.
   * Safe to call multiple times — memoized.
   */
  async initialize(): Promise<boolean> {
    if (this.loading) return this.loading;

    this.loading = (async () => {
      try {
        const { pipeline } = await import("@huggingface/transformers");
        this.pipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
          dtype: "q8",
        });
        this.available = true;
        return true;
      } catch (err) {
        this.opts.onFallback?.(`Semantic model load failed: ${err}`);
        this.available = false;
        return false;
      }
    })();

    return this.loading;
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Generate a 384-dim float32 embedding from text.
   * Mean-pools across sequence length and normalizes to unit length.
   */
  async embed(text: string): Promise<Float32Array | null> {
    if (!this.pipeline) return null;

    const output = await this.pipeline(text, { pooling: "mean", normalize: true });
    return new Float32Array(output.data);
  }

  /**
   * Re-rank search results by semantic similarity to the query.
   * Fetches pre-computed embeddings from DB, embeds the query on-the-fly,
   * blends with FTS5 score, returns re-ordered results.
   */
  async rerank(
    query: string,
    results: SearchResult[],
    repoId: number,
    limit = 5,
  ): Promise<SearchResult[]> {
    if (results.length === 0) return [];

    const queryEmbedding = await this.embed(query);
    if (!queryEmbedding) return results.slice(0, limit);

    // Normalize FTS5 scores to [0, 1]
    const maxFts5 = Math.max(...results.map((r) => r.score), 1);

    const scored = results.map((result) => {
      const fileRecord = queries.getFileByPath(this.opts.db, repoId, result.path);
      const embedding = fileRecord ? this.getEmbedding(fileRecord.id) : null;

      if (!embedding) {
        // No embedding: keep original normalized score
        return { ...result, score: result.score / maxFts5 };
      }

      const semantic = cosineSimilarity(queryEmbedding, embedding);
      const normalizedSemantic = (semantic + 1) / 2; // map [-1,1] to [0,1]
      const normalizedFts5 = result.score / maxFts5;
      const blended = blendScores(normalizedFts5, normalizedSemantic, 0.6);

      return { ...result, score: blended };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Store a file embedding in the database (raw SQL for BLOB handling).
   */
  storeEmbedding(fileId: number, embedding: Float32Array): void {
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.opts.sqlite.prepare("UPDATE files SET embedding = ? WHERE id = ?").run(buf, fileId);
  }

  /**
   * Retrieve a file embedding from the database.
   */
  getEmbedding(fileId: number): Float32Array | null {
    const row = this.opts.sqlite.prepare("SELECT embedding FROM files WHERE id = ?").get(fileId) as
      | { embedding: Buffer | null }
      | undefined;
    if (!row?.embedding) return null;
    const buf = row.embedding;
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }

  // --- Knowledge embedding helpers ---

  /**
   * Store a knowledge entry embedding (raw SQL for BLOB handling).
   * Takes sqlite as param to operate on either repo or global DB.
   */
  storeKnowledgeEmbedding(sqlite: DatabaseType, knowledgeId: number, embedding: Float32Array): void {
    const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    sqlite.prepare("UPDATE knowledge SET embedding = ? WHERE id = ?").run(buf, knowledgeId);
  }

  /**
   * Vector search across knowledge entries in a given DB.
   * Returns scored results sorted by cosine similarity.
   */
  searchKnowledgeByVector(
    sqlite: DatabaseType,
    queryEmbedding: Float32Array,
    limit = 10,
    statusFilter = "active",
  ): Array<{ id: number; key: string; title: string; content: string; type: string; tagsJson: string | null; score: number }> {
    const rows = sqlite
      .prepare("SELECT id, key, title, content, type, tags_json, embedding FROM knowledge WHERE embedding IS NOT NULL AND status = ?")
      .all(statusFilter) as Array<{ id: number; key: string; title: string; content: string; type: string; tags_json: string | null; embedding: Buffer }>;

    const scored = rows.map((row) => {
      const emb = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const similarity = cosineSimilarity(queryEmbedding, emb);
      return {
        id: row.id,
        key: row.key,
        title: row.title,
        content: row.content,
        type: row.type,
        tagsJson: row.tags_json,
        score: (similarity + 1) / 2, // map [-1,1] to [0,1]
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  /**
   * Vector search: embed the query and scan file embeddings by cosine similarity.
   * Unlike rerank(), this is not gated by FTS5 — it can discover files with zero token overlap.
   * O(n) where n = files with embeddings (filtered by scope if provided).
   * Applies test/config file penalties consistent with FTS5 search.
   */
  async vectorSearch(query: string, repoId: number, limit = 10, scope?: string): Promise<SearchResult[]> {
    const queryEmbedding = await this.embed(query);
    if (!queryEmbedding) return [];

    const queryMentionsTest = /test|spec/i.test(query);

    // Filter by scope at SQL level (not post-hoc) to avoid false positives
    let sql = "SELECT id, path, embedding FROM files WHERE repo_id = ? AND embedding IS NOT NULL";
    const params: unknown[] = [repoId];
    if (scope) {
      sql += " AND path LIKE ?";
      params.push(scope.replace(/%/g, "\\%") + "%");
    }

    const rows = this.opts.sqlite
      .prepare(sql)
      .all(...params) as Array<{ id: number; path: string; embedding: Buffer }>;

    const scored: SearchResult[] = [];
    for (const row of rows) {
      const fileEmb = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
      const similarity = cosineSimilarity(queryEmbedding, fileEmb);
      let score = (similarity + 1) / 2; // map [-1,1] → [0,1]

      // Consistent test file penalty across both search paths (FTS5 + vector)
      if (!queryMentionsTest && isTestFile(row.path)) {
        score *= 0.4;
      }

      scored.push({ path: row.path, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }
}

/**
 * Merge FTS5 and vector search results into a single ranked list.
 *
 * For files found by both sources, blends their scores.
 * For files found by only one source, uses a partial score so that
 * vector-only results (the key hybrid win) still appear in output.
 */
export function mergeResults(
  fts5Results: SearchResult[],
  vectorResults: SearchResult[],
  limit = 10,
  alpha = 0.5,
  scopeActive = false,
): SearchResult[] {
  // Normalize FTS5 scores to [0, 1]
  const maxFts5 = Math.max(...fts5Results.map((r) => r.score), 1);

  // Build lookup maps
  const fts5Map = new Map<string, SearchResult>();
  for (const r of fts5Results) {
    fts5Map.set(r.path, r);
  }
  const vectorMap = new Map<string, number>();
  for (const r of vectorResults) {
    vectorMap.set(r.path, r.score); // already [0,1] from vectorSearch
  }

  // When scope is active and FTS5 found nothing, vector-only results may be tangential —
  // but the penalty must be gentle: FTS5 emptiness can be due to AND semantics or sparse
  // indexed content, not necessarily irrelevant files. A harsh penalty (e.g., 0.5x)
  // compounds with alpha to yield 0.25x which drops valid results below threshold.
  const demoteVectorOnly = scopeActive && fts5Results.length === 0;

  // Union all paths
  const allPaths = new Set([...fts5Map.keys(), ...vectorMap.keys()]);
  const merged: SearchResult[] = [];

  for (const path of allPaths) {
    const fts5Entry = fts5Map.get(path);
    const vectorScore = vectorMap.get(path);
    const normalizedFts5 = fts5Entry ? fts5Entry.score / maxFts5 : undefined;

    let score: number;
    if (normalizedFts5 !== undefined && vectorScore !== undefined) {
      // Both sources — full blend
      score = blendScores(normalizedFts5, vectorScore, alpha);
    } else if (normalizedFts5 !== undefined) {
      // FTS5 only — penalized (no semantic signal)
      score = normalizedFts5 * (1 - alpha);
    } else {
      // Vector only — gentle demote when scoped FTS5 found nothing (0.7x not 0.5x)
      // With alpha=0.5: effective score = vec * 0.5 * 0.7 = vec * 0.35 — still above threshold
      score = vectorScore! * alpha * (demoteVectorOnly ? 0.7 : 1.0);
    }

    merged.push({
      path,
      score,
      // Preserve FTS5 metadata when available
      ...(fts5Entry?.matchLines && { matchLines: fts5Entry.matchLines }),
      ...(fts5Entry?.snippet && { snippet: fts5Entry.snippet }),
    });
  }

  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
}

/**
 * Cosine similarity between two vectors.
 * Returns value in [-1, 1]. Returns 0 for zero-length vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Blend FTS5 rank score with semantic similarity.
 * alpha controls weight of semantic (default 0.5 = equal weight, optimal per benchmark).
 */
export function blendScores(fts5Score: number, semanticScore: number, alpha = 0.5): number {
  return alpha * semanticScore + (1 - alpha) * fts5Score;
}

/**
 * Options for building embedding text from file metadata.
 * The richer the input, the better the embedding quality.
 */
export interface EmbeddingTextOptions {
  path: string;
  language: string | null;
  summary: string;
  symbolsJson: string;
  imports?: string[];
  leadingComment?: string;
}

/**
 * Build a rich natural-language text to embed for a file.
 *
 * Combines structural metadata (path, language, symbols with kinds,
 * imports) and optional doc comments into a dense text representation
 * that gives the embedding model ~50-100 tokens to work with instead
 * of the previous ~10.
 */
export function buildEmbeddingText(opts: EmbeddingTextOptions): string {
  const parts: string[] = [];

  // Path provides strong semantic signal (e.g., "src/trust/tiers.ts" → trust, tiers)
  parts.push(`file: ${opts.path}`);

  if (opts.language) {
    parts.push(`language: ${opts.language}`);
  }

  // Summary line (existing: "Functions: foo | Classes: Bar | 80 lines")
  if (opts.summary) {
    parts.push(opts.summary);
  }

  // Symbols with their kinds — "class SearchRouter", "function search", "method rerank"
  try {
    const symbols = JSON.parse(opts.symbolsJson) as Array<{ name: string; kind?: string }>;
    if (symbols.length > 0) {
      const symbolText = symbols
        .map((s) => (s.kind ? `${s.kind} ${s.name}` : s.name))
        .join(", ");
      parts.push(`symbols: ${symbolText}`);
    }
  } catch {
    // ignore parse errors
  }

  // Import sources — "imports: ./interface.js, drizzle-orm, better-sqlite3"
  if (opts.imports && opts.imports.length > 0) {
    parts.push(`imports: ${opts.imports.join(", ")}`);
  }

  // Leading doc comment (truncated to 200 chars to avoid dominating embedding)
  if (opts.leadingComment) {
    const trimmed = opts.leadingComment.slice(0, 200).trim();
    if (trimmed) {
      parts.push(trimmed);
    }
  }

  return parts.join(". ").trim();
}
