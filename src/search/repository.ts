import type { Result } from "../core/result.js";
import type { StorageError } from "../core/errors.js";

/** Search result with score */
export interface SearchResult {
  readonly id: string;
  readonly title: string;
  readonly type: "knowledge" | "work";
  readonly score: number;
  readonly snippet: string;
}

/** Search query options */
export interface SearchOptions {
  readonly query: string;
  readonly type?: "knowledge" | "work" | "all";
  readonly limit?: number;
  readonly offset?: number;
  readonly semanticEnabled?: boolean;
}

/** Semantic search result (cosine similarity) */
export interface SemanticResult {
  readonly id: string;
  readonly score: number; // cosine similarity [0, 1]
}

/** Search index repository */
export interface SearchIndexRepository {
  indexArticle(id: string, title: string, content: string, type: "knowledge" | "work"): Promise<Result<void, StorageError>>;
  removeArticle(id: string): Promise<Result<void, StorageError>>;
  search(options: SearchOptions): Promise<Result<SearchResult[], StorageError>>;
  /** Rebuild all derived index structures (inverted index, title terms) from stored documents. */
  reindex(): Promise<Result<void, StorageError>>;
  /** Remove all documents and index structures from the index. */
  clear(): Promise<Result<void, StorageError>>;
  /** Number of documents currently stored in the index. */
  readonly size: number;
  /** Run a canary check: true if the index can return results, false if queries produce nothing despite having documents. */
  canary(): Promise<boolean>;

  // ─── Semantic / vector methods ──────────────────────────────────────────────
  /** Store an embedding vector for a document. */
  storeEmbedding(id: string, embedding: number[]): Promise<Result<void, StorageError>>;
  /** Find the top-k most similar documents to a query vector via cosine similarity. */
  searchSemantic(queryEmbedding: number[], limit: number, type?: "knowledge" | "work" | "all"): Promise<Result<SemanticResult[], StorageError>>;
  /** Number of stored embedding vectors. */
  readonly embeddingCount: number;
}
