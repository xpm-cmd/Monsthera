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
  readonly references: readonly string[];
  readonly sourcePath?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Passthrough for custom frontmatter fields not in the standard schema. Enables
   * category-specific extensions (e.g. `policy` articles carry `policy_applies_templates`,
   * `policy_requires_roles`, etc.) without modifying the core schema. File-backed
   * repositories preserve these fields on read and re-serialize them on write.
   */
  readonly extraFrontmatter?: Readonly<Record<string, unknown>>;
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
  references?: string[];
  sourcePath?: string;
  createdAt?: string;
  updatedAt?: string;
  /** See `KnowledgeArticle.extraFrontmatter`. Preserved as-is through create. */
  extraFrontmatter?: Record<string, unknown>;
}

/** Input for updating a knowledge article */
export interface UpdateKnowledgeArticleInput {
  title?: string;
  category?: string;
  content?: string;
  tags?: string[];
  codeRefs?: string[];
  references?: string[];
  sourcePath?: string;
  /** See `KnowledgeArticle.extraFrontmatter`. Replaces any prior map when supplied. */
  extraFrontmatter?: Record<string, unknown>;
}

/** Knowledge article repository with domain-specific queries */
export interface KnowledgeArticleRepository
  extends Repository<KnowledgeArticle, CreateKnowledgeArticleInput, UpdateKnowledgeArticleInput> {
  findBySlug(slug: Slug): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>>;
  findByCategory(category: string): Promise<Result<KnowledgeArticle[], StorageError>>;
  findByTag(tag: string): Promise<Result<KnowledgeArticle[], StorageError>>;
  search(query: string): Promise<Result<KnowledgeArticle[], StorageError>>;
  /**
   * Write an article with a specific new slug (and optional content/references/etc. overrides),
   * removing any prior file at the old slug if the slug is changing.
   *
   * This bypasses the title→slug auto-regeneration that `update` does. It is
   * the primitive used by the service-layer rename orchestration. Content +
   * references overrides make it usable for referrer rewrites in the same
   * staged-write loop (where the slug does NOT change but body/references do).
   */
  writeWithSlug(
    id: string,
    input: WriteWithSlugInput,
  ): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>>;
}

/** Input for writeWithSlug — all fields optional; identity is id. */
export interface WriteWithSlugInput {
  slug?: Slug;
  content?: string;
  references?: string[];
  title?: string;
  category?: string;
  tags?: string[];
  codeRefs?: string[];
}
