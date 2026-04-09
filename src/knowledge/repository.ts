import type { Repository } from "../core/repository.js";
import type { Result } from "../core/result.js";
import type { ArticleId, Slug } from "../core/types.js";
import type { NotFoundError, StorageError } from "../core/errors.js";

/** Knowledge article entity (as returned from repository) */
export interface KnowledgeArticle {
  readonly id: ArticleId;
  readonly title: string;
  readonly slug: Slug;
  readonly category: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly codeRefs: readonly string[];
  readonly sourcePath?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Input for creating a knowledge article */
export interface CreateKnowledgeArticleInput {
  id?: ArticleId;
  title: string;
  slug?: Slug;
  category: string;
  content: string;
  tags?: string[];
  codeRefs?: string[];
  sourcePath?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Input for updating a knowledge article */
export interface UpdateKnowledgeArticleInput {
  title?: string;
  category?: string;
  content?: string;
  tags?: string[];
  codeRefs?: string[];
  sourcePath?: string;
}

/** Knowledge article repository with domain-specific queries */
export interface KnowledgeArticleRepository
  extends Repository<KnowledgeArticle, CreateKnowledgeArticleInput, UpdateKnowledgeArticleInput> {
  findBySlug(slug: Slug): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>>;
  findByCategory(category: string): Promise<Result<KnowledgeArticle[], StorageError>>;
  findByTag(tag: string): Promise<Result<KnowledgeArticle[], StorageError>>;
  search(query: string): Promise<Result<KnowledgeArticle[], StorageError>>;
}
