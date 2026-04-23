import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { NotFoundError } from "../core/errors.js";
import type { StorageError, ValidationError } from "../core/errors.js";
import { generateArticleId, timestamp } from "../core/types.js";
import type { ArticleId, Slug } from "../core/types.js";
import { uniqueSlug } from "./slug.js";
import type {
  KnowledgeArticle,
  KnowledgeArticleRepository,
  CreateKnowledgeArticleInput,
  UpdateKnowledgeArticleInput,
  WriteWithSlugInput,
} from "./repository.js";

export class InMemoryKnowledgeArticleRepository implements KnowledgeArticleRepository {
  private readonly store = new Map<string, KnowledgeArticle>();

  private existingSlugs(): Set<string> {
    const slugs = new Set<string>();
    for (const article of this.store.values()) {
      slugs.add(article.slug);
    }
    return slugs;
  }

  async findById(id: string): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    const article = this.store.get(id);
    if (!article) return err(new NotFoundError("KnowledgeArticle", id));
    return ok(article);
  }

  async findMany(_filter?: Record<string, unknown>): Promise<Result<KnowledgeArticle[], StorageError>> {
    return ok([...this.store.values()]);
  }

  async create(input: CreateKnowledgeArticleInput): Promise<Result<KnowledgeArticle, ValidationError | StorageError>> {
    const id: ArticleId = input.id ?? generateArticleId();
    const articleSlug: Slug = input.slug ?? uniqueSlug(input.title, this.existingSlugs());
    const createdAt = timestamp(input.createdAt);
    const updatedAt = timestamp(input.updatedAt ?? input.createdAt);

    const article: KnowledgeArticle = {
      id,
      title: input.title,
      slug: articleSlug,
      category: input.category,
      content: input.content,
      tags: input.tags ?? [],
      codeRefs: input.codeRefs ?? [],
      references: input.references ?? [],
      sourcePath: input.sourcePath,
      createdAt,
      updatedAt,
      ...(input.extraFrontmatter ? { extraFrontmatter: { ...input.extraFrontmatter } } : {}),
    };

    this.store.set(id, article);
    return ok(article);
  }

  async update(
    id: string,
    input: UpdateKnowledgeArticleInput,
  ): Promise<Result<KnowledgeArticle, NotFoundError | ValidationError | StorageError>> {
    const existing = this.store.get(id);
    if (!existing) return err(new NotFoundError("KnowledgeArticle", id));

    let newSlug: Slug = existing.slug;
    if (input.title !== undefined && input.title !== existing.title) {
      const slugsWithoutCurrent = this.existingSlugs();
      slugsWithoutCurrent.delete(existing.slug);
      newSlug = uniqueSlug(input.title, slugsWithoutCurrent);
    }

    const updated: KnowledgeArticle = {
      ...existing,
      title: input.title ?? existing.title,
      slug: newSlug,
      category: input.category ?? existing.category,
      content: input.content ?? existing.content,
      tags: input.tags ?? existing.tags,
      codeRefs: input.codeRefs ?? existing.codeRefs,
      references: input.references ?? existing.references,
      sourcePath: input.sourcePath ?? existing.sourcePath,
      ...(input.extraFrontmatter !== undefined
        ? { extraFrontmatter: { ...input.extraFrontmatter } }
        : existing.extraFrontmatter
          ? { extraFrontmatter: existing.extraFrontmatter }
          : {}),
      updatedAt: timestamp(),
    };

    this.store.set(id, updated);
    return ok(updated);
  }

  async delete(id: string): Promise<Result<void, NotFoundError | StorageError>> {
    if (!this.store.has(id)) return err(new NotFoundError("KnowledgeArticle", id));
    this.store.delete(id);
    return ok(undefined);
  }

  async exists(id: string): Promise<boolean> {
    return this.store.has(id);
  }

  async findBySlug(slug: Slug): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    for (const article of this.store.values()) {
      if (article.slug === slug) return ok(article);
    }
    return err(new NotFoundError("KnowledgeArticle", `slug:${slug}`));
  }

  async findByCategory(category: string): Promise<Result<KnowledgeArticle[], StorageError>> {
    const lower = category.toLowerCase();
    const results = [...this.store.values()].filter((a) => a.category.toLowerCase() === lower);
    return ok(results);
  }

  async findByTag(tag: string): Promise<Result<KnowledgeArticle[], StorageError>> {
    const results = [...this.store.values()].filter((a) => a.tags.includes(tag));
    return ok(results);
  }

  async writeWithSlug(
    id: string,
    input: WriteWithSlugInput,
  ): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    const existing = this.store.get(id);
    if (!existing) return err(new NotFoundError("KnowledgeArticle", id));

    const updated: KnowledgeArticle = {
      ...existing,
      title: input.title ?? existing.title,
      slug: input.slug ?? existing.slug,
      category: input.category ?? existing.category,
      content: input.content ?? existing.content,
      tags: input.tags ?? existing.tags,
      codeRefs: input.codeRefs ?? existing.codeRefs,
      references: input.references ?? existing.references,
      updatedAt: timestamp(),
    };

    this.store.set(id, updated);
    return ok(updated);
  }

  async search(query: string): Promise<Result<KnowledgeArticle[], StorageError>> {
    const lower = query.toLowerCase();
    const results = [...this.store.values()].filter(
      (a) =>
        a.title.toLowerCase().includes(lower) ||
        a.content.toLowerCase().includes(lower) ||
        a.category.toLowerCase().includes(lower) ||
        a.tags.some((t) => t.toLowerCase().includes(lower)),
    );
    return ok(results);
  }
}
