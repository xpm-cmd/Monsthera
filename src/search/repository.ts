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

/** Search index repository */
export interface SearchIndexRepository {
  indexArticle(id: string, title: string, content: string, type: "knowledge" | "work"): Promise<Result<void, StorageError>>;
  removeArticle(id: string): Promise<Result<void, StorageError>>;
  search(options: SearchOptions): Promise<Result<SearchResult[], StorageError>>;
  reindex(): Promise<Result<void, StorageError>>;
}
