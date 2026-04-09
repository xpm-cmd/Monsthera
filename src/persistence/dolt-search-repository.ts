import type { Pool, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { StorageError } from "../core/errors.js";
import type { SearchIndexRepository, SearchOptions, SearchResult, SemanticResult } from "../search/repository.js";
import { tokenize } from "../search/tokenizer.js";

interface SearchDocumentRow extends RowDataPacket {
  id: string;
  title: string;
  content: string;
  type: "knowledge" | "work";
  indexed_at: string;
}

interface InvertedIndexRow extends RowDataPacket {
  term: string;
  doc_id: string;
}

// ---------------------------------------------------------------------------
// BM25-lite constants
// ---------------------------------------------------------------------------

const BM25_K1 = 1.2;
const TITLE_BOOST = 3.0;
const SNIPPET_RADIUS = 80;
const SNIPPET_MAX_FALLBACK = 160;
const DEFAULT_LIMIT = 20;
const DEFAULT_OFFSET = 0;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DoltSearchIndexRepository implements SearchIndexRepository {
  /** In-memory embedding cache (Dolt has no native vector column type). */
  private readonly embeddings = new Map<string, number[]>();

  constructor(private readonly pool: Pool) {}

  async indexArticle(
    id: string,
    title: string,
    content: string,
    type: "knowledge" | "work",
  ): Promise<Result<void, StorageError>> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      // Upsert into search_documents
      const indexedAt = new Date().toISOString();
      await connection.query<ResultSetHeader>(
        `INSERT INTO search_documents (id, title, content, type, indexed_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         content = VALUES(content),
         type = VALUES(type),
         indexed_at = VALUES(indexed_at)`,
        [id, title, content, type, indexedAt],
      );

      // Remove existing inverted index entries for this document
      await connection.query<ResultSetHeader>("DELETE FROM search_inverted_index WHERE doc_id = ?", [
        id,
      ]);

      // Re-tokenize title and content, then add to inverted index
      const titleTokens = tokenize(title);
      const contentTokens = tokenize(content);
      const allTokens = [...titleTokens, ...contentTokens];

      if (allTokens.length > 0) {
        // Deduplicate tokens for this document
        const uniqueTokens = new Set(allTokens);

        // Insert each unique term into inverted index
        for (const term of uniqueTokens) {
          await connection.query<ResultSetHeader>(
            `INSERT INTO search_inverted_index (term, doc_id)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE doc_id = doc_id`,
            [term, id],
          );
        }
      }

      await connection.commit();
      return ok(undefined);
    } catch (error) {
      await connection.rollback();
      return err(new StorageError(`Failed to index article: ${id}`, { cause: error }));
    } finally {
      connection.release();
    }
  }

  async removeArticle(id: string): Promise<Result<void, StorageError>> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      // Remove child rows before the parent document to satisfy FK constraints.
      await connection.query<ResultSetHeader>("DELETE FROM search_inverted_index WHERE doc_id = ?", [
        id,
      ]);

      // Remove from search_documents
      await connection.query<ResultSetHeader>("DELETE FROM search_documents WHERE id = ?", [id]);

      await connection.commit();
      return ok(undefined);
    } catch (error) {
      await connection.rollback();
      return err(new StorageError(`Failed to remove article: ${id}`, { cause: error }));
    } finally {
      connection.release();
    }
  }

  async search(options: SearchOptions): Promise<Result<SearchResult[], StorageError>> {
    try {
      const { query, type, limit = DEFAULT_LIMIT, offset = DEFAULT_OFFSET } = options;

      // Empty / whitespace-only query → no results
      const queryTerms = tokenize(query);
      if (queryTerms.length === 0) {
        return ok([]);
      }

      // Find candidate doc IDs that contain any of the query terms
      const placeholders = queryTerms.map(() => "?").join(",");
      const [indexRows] = await this.pool.query<InvertedIndexRow[]>(
        `SELECT DISTINCT doc_id FROM search_inverted_index WHERE term IN (${placeholders})`,
        queryTerms,
      );

      const candidateIds = new Set<string>();
      for (const row of indexRows) {
        candidateIds.add(row.doc_id);
      }

      if (candidateIds.size === 0) {
        return ok([]);
      }

      // Fetch candidate documents
      const docPlaceholders = Array.from(candidateIds)
        .map(() => "?")
        .join(",");
      const [docRows] = await this.pool.query<SearchDocumentRow[]>(
        `SELECT id, title, content, type, indexed_at FROM search_documents WHERE id IN (${docPlaceholders})`,
        Array.from(candidateIds),
      );

      // Get total document count for BM25 IDF calculation
      const [countRows] = await this.pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) as count FROM search_documents",
      );
      const N = (countRows[0] as RowDataPacket & { count: number }).count || 0;

      // Fetch document frequencies for all query terms
      const termDfMap = await this.getDocumentFrequencies(queryTerms);

      // Score and filter candidates
      const scored: Array<{ doc: SearchDocumentRow; score: number }> = [];

      for (const doc of docRows) {
        // Apply type filter
        if (type !== undefined && type !== "all" && doc.type !== type) continue;

        const score = this.bm25Score(doc, queryTerms, N, termDfMap);
        scored.push({ doc, score });
      }

      // Sort by score descending
      scored.sort((a, b) => b.score - a.score);

      // Apply offset + limit and build results
      const page = scored.slice(offset, offset + limit);
      const results: SearchResult[] = page.map(({ doc, score }) => ({
        id: doc.id,
        title: doc.title,
        type: doc.type,
        score,
        snippet: generateSnippet(doc.content, queryTerms),
      }));

      return ok(results);
    } catch (error) {
      return err(new StorageError("Failed to search", { cause: error }));
    }
  }

  async reindex(): Promise<Result<void, StorageError>> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      // Clear inverted index
      await connection.query<ResultSetHeader>("TRUNCATE TABLE search_inverted_index");

      // Fetch all documents
      const [docs] = await connection.query<SearchDocumentRow[]>(
        "SELECT id, title, content, type FROM search_documents",
      );

      // Rebuild inverted index
      for (const doc of docs) {
        const titleTokens = tokenize(doc.title);
        const contentTokens = tokenize(doc.content);
        const allTokens = [...titleTokens, ...contentTokens];
        const uniqueTokens = new Set(allTokens);

        for (const term of uniqueTokens) {
          await connection.query<ResultSetHeader>(
            "INSERT INTO search_inverted_index (term, doc_id) VALUES (?, ?)",
            [term, doc.id],
          );
        }
      }

      await connection.commit();
      return ok(undefined);
    } catch (error) {
      await connection.rollback();
      return err(new StorageError("Failed to reindex", { cause: error }));
    } finally {
      connection.release();
    }
  }

  async clear(): Promise<Result<void, StorageError>> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();

      // Truncate both tables
      await connection.query<ResultSetHeader>("TRUNCATE TABLE search_inverted_index");
      await connection.query<ResultSetHeader>("TRUNCATE TABLE search_documents");

      await connection.commit();
      return ok(undefined);
    } catch (error) {
      await connection.rollback();
      return err(new StorageError("Failed to clear search index", { cause: error }));
    } finally {
      connection.release();
    }
  }

  // -------------------------------------------------------------------------
  // Semantic / vector methods (in-memory cache, Dolt lacks vector columns)
  // -------------------------------------------------------------------------

  async storeEmbedding(id: string, embedding: number[]): Promise<Result<void, StorageError>> {
    this.embeddings.set(id, embedding);
    return ok(undefined);
  }

  async searchSemantic(
    queryEmbedding: number[],
    limit: number,
    type?: "knowledge" | "work" | "all",
  ): Promise<Result<SemanticResult[], StorageError>> {
    try {
      const scored: Array<{ id: string; score: number }> = [];

      for (const [id, docEmbedding] of this.embeddings) {
        if (type !== undefined && type !== "all") {
          // Check doc type via SQL
          const [rows] = await this.pool.query<RowDataPacket[]>(
            "SELECT type FROM search_documents WHERE id = ?",
            [id],
          );
          if (rows.length === 0 || (rows[0] as RowDataPacket & { type: string }).type !== type) continue;
        }
        const score = cosineSimilarity(queryEmbedding, docEmbedding);
        scored.push({ id, score });
      }

      scored.sort((a, b) => b.score - a.score);
      return ok(scored.slice(0, limit));
    } catch (error) {
      return err(new StorageError("Failed to search semantically", { cause: error }));
    }
  }

  get embeddingCount(): number {
    return this.embeddings.size;
  }

  // -------------------------------------------------------------------------
  // size + canary
  // -------------------------------------------------------------------------

  private cachedSize = 0;

  get size(): number {
    return this.cachedSize;
  }

  async canary(): Promise<boolean> {
    try {
      const [countRows] = await this.pool.query<RowDataPacket[]>(
        "SELECT COUNT(*) as count FROM search_documents",
      );
      this.cachedSize = (countRows[0] as RowDataPacket & { count: number }).count || 0;
      if (this.cachedSize === 0) return true;

      // Pick any term from the inverted index and verify search returns results
      const [termRows] = await this.pool.query<RowDataPacket[]>(
        "SELECT term FROM search_inverted_index LIMIT 1",
      );
      if (termRows.length === 0) return false; // documents exist but no terms indexed
      const term = (termRows[0] as RowDataPacket & { term: string }).term;
      const result = await this.search({ query: term, limit: 1 });
      return result.ok && result.value.length > 0;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch document frequencies for all query terms in a single query.
   */
  private async getDocumentFrequencies(queryTerms: string[]): Promise<Map<string, number>> {
    const dfMap = new Map<string, number>();

    if (queryTerms.length === 0) return dfMap;

    try {
      const placeholders = queryTerms.map(() => "?").join(",");
      const [dfRows] = await this.pool.query<RowDataPacket[]>(
        `SELECT term, COUNT(*) as count FROM search_inverted_index WHERE term IN (${placeholders}) GROUP BY term`,
        queryTerms,
      );

      for (const row of dfRows) {
        const term = row.term as string;
        const count = (row as RowDataPacket & { count: number }).count || 0;
        dfMap.set(term, count);
      }
    } catch {
      // On error, return empty map (all terms will have df=0)
    }

    return dfMap;
  }

  /**
   * BM25-lite scoring with title boost.
   * Formula: sum over query terms of: (tf / (tf + K1)) * IDF * fieldBoost
   */
  private bm25Score(
    doc: SearchDocumentRow,
    queryTerms: string[],
    N: number,
    termDfMap: Map<string, number>,
  ): number {
    // Pre-compute term frequencies in the combined token stream
    const allText = `${doc.title} ${doc.content}`;
    const docTokens = tokenize(allText);
    const termFrequencies = new Map<string, number>();
    for (const token of docTokens) {
      termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1);
    }

    // Get title tokens for title boost
    const titleTokens = new Set(tokenize(doc.title));

    let totalScore = 0;

    for (const term of queryTerms) {
      const tf = termFrequencies.get(term) ?? 0;
      if (tf === 0) continue;

      const df = termDfMap.get(term) ?? 0;
      const saturatedTf = tf / (tf + BM25_K1);
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      const fieldBoost = titleTokens.has(term) ? TITLE_BOOST : 1.0;

      totalScore += saturatedTf * idf * fieldBoost;
    }

    return totalScore;
  }
}

// ---------------------------------------------------------------------------
// Snippet generation (module-level pure function)
// ---------------------------------------------------------------------------

function generateSnippet(content: string, queryTerms: string[]): string {
  if (content.length === 0) return "";

  const lower = content.toLowerCase();

  // Find the first occurrence of any query term
  let firstMatchIndex = -1;
  for (const term of queryTerms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (firstMatchIndex === -1 || idx < firstMatchIndex)) {
      firstMatchIndex = idx;
    }
  }

  if (firstMatchIndex === -1) {
    // No match in content — return the first 160 chars
    const fallback = content.slice(0, SNIPPET_MAX_FALLBACK);
    return content.length > SNIPPET_MAX_FALLBACK ? `${fallback}...` : fallback;
  }

  const start = Math.max(0, firstMatchIndex - SNIPPET_RADIUS);
  const end = Math.min(content.length, firstMatchIndex + SNIPPET_RADIUS);
  const snippet = content.slice(start, end);

  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return `${prefix}${snippet}${suffix}`;
}

// ---------------------------------------------------------------------------
// Cosine similarity
// ---------------------------------------------------------------------------

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
