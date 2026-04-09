import type { Result } from "../core/result.js";
import type { NotFoundError, StorageError } from "../core/errors.js";

/**
 * Minimal surface used by mutating services to keep the search index in sync
 * without depending on the full SearchService implementation.
 */
export interface SearchMutationSync {
  indexKnowledgeArticle(id: string): Promise<Result<void, NotFoundError | StorageError>>;
  indexWorkArticle(id: string): Promise<Result<void, NotFoundError | StorageError>>;
  removeArticle(id: string): Promise<Result<void, StorageError>>;
}
