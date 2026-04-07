import type { Pool, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { NotFoundError, StorageError, ValidationError } from "../core/errors.js";
import { generateArticleId, articleId, timestamp } from "../core/types.js";
import type { ArticleId, Slug } from "../core/types.js";
import { uniqueSlug } from "../knowledge/slug.js";
import type {
  KnowledgeArticle,
  KnowledgeArticleRepository,
  CreateKnowledgeArticleInput,
  UpdateKnowledgeArticleInput,
} from "../knowledge/repository.js";

interface ArticleRow extends RowDataPacket {
  id: string;
  title: string;
  slug: string;
  category: string;
  content: string;
  tags: string;
  codeRefs: string;
  createdAt: string;
  updatedAt: string;
}

export class DoltKnowledgeArticleRepository implements KnowledgeArticleRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    try {
      const [rows] = await this.pool.query<ArticleRow[]>(
        "SELECT id, title, slug, category, content, tags, codeRefs, createdAt, updatedAt FROM knowledge_articles WHERE id = ?",
        [id],
      );

      if (rows.length === 0) {
        return err(new NotFoundError("KnowledgeArticle", id));
      }

      return ok(this.mapRowToArticle(rows[0]!));
    } catch (error) {
      return err(new StorageError(`Failed to find article by id: ${id}`, { cause: error }));
    }
  }

  async findMany(_filter?: Record<string, unknown>): Promise<Result<KnowledgeArticle[], StorageError>> {
    try {
      const [rows] = await this.pool.query<ArticleRow[]>(
        "SELECT id, title, slug, category, content, tags, codeRefs, createdAt, updatedAt FROM knowledge_articles",
      );

      return ok(rows.map((row) => this.mapRowToArticle(row)));
    } catch (error) {
      return err(new StorageError("Failed to find many articles", { cause: error }));
    }
  }

  async create(
    input: CreateKnowledgeArticleInput,
  ): Promise<Result<KnowledgeArticle, ValidationError | StorageError>> {
    try {
      const id = generateArticleId();
      const existingSlugsResult = await this.getExistingSlugs();
      if (!existingSlugsResult.ok) return existingSlugsResult;

      const articleSlug = uniqueSlug(input.title, existingSlugsResult.value);
      const now = timestamp();
      const tagsJson = JSON.stringify(input.tags ?? []);
      const codeRefsJson = JSON.stringify(input.codeRefs ?? []);

      await this.pool.query<ResultSetHeader>(
        `INSERT INTO knowledge_articles
         (id, title, slug, category, content, tags, codeRefs, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, input.title, articleSlug, input.category, input.content, tagsJson, codeRefsJson, now, now],
      );

      const article: KnowledgeArticle = {
        id,
        title: input.title,
        slug: articleSlug,
        category: input.category,
        content: input.content,
        tags: input.tags ?? [],
        codeRefs: input.codeRefs ?? [],
        createdAt: now,
        updatedAt: now,
      };
      return ok(article);
    } catch (error) {
      return err(new StorageError("Failed to create article", { cause: error }));
    }
  }

  async update(
    id: string,
    input: UpdateKnowledgeArticleInput,
  ): Promise<Result<KnowledgeArticle, NotFoundError | ValidationError | StorageError>> {
    try {
      const existingResult = await this.findById(id);
      if (!existingResult.ok) return existingResult;

      const existing = existingResult.value;

      let newSlug: Slug = existing.slug;
      if (input.title !== undefined && input.title !== existing.title) {
        const slugsResult = await this.getExistingSlugs();
        if (!slugsResult.ok) return slugsResult;

        const slugsWithoutCurrent = new Set(slugsResult.value);
        slugsWithoutCurrent.delete(existing.slug);
        newSlug = uniqueSlug(input.title, slugsWithoutCurrent);
      }

      const updatedTitle = input.title ?? existing.title;
      const updatedCategory = input.category ?? existing.category;
      const updatedContent = input.content ?? existing.content;
      const updatedTags = input.tags ?? existing.tags;
      const updatedCodeRefs = input.codeRefs ?? existing.codeRefs;
      const updatedAt = timestamp();

      const tagsJson = JSON.stringify(updatedTags);
      const codeRefsJson = JSON.stringify(updatedCodeRefs);

      await this.pool.query<ResultSetHeader>(
        `UPDATE knowledge_articles
         SET title = ?, slug = ?, category = ?, content = ?, tags = ?, codeRefs = ?, updatedAt = ?
         WHERE id = ?`,
        [updatedTitle, newSlug, updatedCategory, updatedContent, tagsJson, codeRefsJson, updatedAt, id],
      );

      const article: KnowledgeArticle = {
        id: articleId(id),
        title: updatedTitle,
        slug: newSlug,
        category: updatedCategory,
        content: updatedContent,
        tags: updatedTags,
        codeRefs: updatedCodeRefs,
        createdAt: existing.createdAt,
        updatedAt: updatedAt,
      };
      return ok(article);
    } catch (error) {
      return err(new StorageError(`Failed to update article: ${id}`, { cause: error }));
    }
  }

  async delete(id: string): Promise<Result<void, NotFoundError | StorageError>> {
    try {
      const existsResult = await this.exists(id);
      if (!existsResult) {
        return err(new NotFoundError("KnowledgeArticle", id));
      }

      await this.pool.query<ResultSetHeader>("DELETE FROM knowledge_articles WHERE id = ?", [id]);

      return ok(undefined);
    } catch (error) {
      return err(new StorageError(`Failed to delete article: ${id}`, { cause: error }));
    }
  }

  async exists(id: string): Promise<boolean> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        "SELECT 1 FROM knowledge_articles WHERE id = ?",
        [id],
      );
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  async findBySlug(slug: Slug): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    try {
      const [rows] = await this.pool.query<ArticleRow[]>(
        "SELECT id, title, slug, category, content, tags, codeRefs, createdAt, updatedAt FROM knowledge_articles WHERE slug = ?",
        [slug],
      );

      if (rows.length === 0) {
        return err(new NotFoundError("KnowledgeArticle", `slug:${slug}`));
      }

      return ok(this.mapRowToArticle(rows[0]!));
    } catch (error) {
      return err(new StorageError(`Failed to find article by slug: ${slug}`, { cause: error }));
    }
  }

  async findByCategory(category: string): Promise<Result<KnowledgeArticle[], StorageError>> {
    try {
      const [rows] = await this.pool.query<ArticleRow[]>(
        "SELECT id, title, slug, category, content, tags, codeRefs, createdAt, updatedAt FROM knowledge_articles WHERE LOWER(category) = LOWER(?)",
        [category],
      );

      return ok(rows.map((row) => this.mapRowToArticle(row)));
    } catch (error) {
      return err(new StorageError(`Failed to find articles by category: ${category}`, { cause: error }));
    }
  }

  async findByTag(tag: string): Promise<Result<KnowledgeArticle[], StorageError>> {
    try {
      const [rows] = await this.pool.query<ArticleRow[]>(
        "SELECT id, title, slug, category, content, tags, codeRefs, createdAt, updatedAt FROM knowledge_articles WHERE JSON_CONTAINS(tags, ?)",
        [JSON.stringify(tag)],
      );

      return ok(rows.map((row) => this.mapRowToArticle(row)));
    } catch (error) {
      return err(new StorageError(`Failed to find articles by tag: ${tag}`, { cause: error }));
    }
  }

  async search(query: string): Promise<Result<KnowledgeArticle[], StorageError>> {
    try {
      const searchPattern = `%${query}%`;
      const [rows] = await this.pool.query<ArticleRow[]>(
        `SELECT id, title, slug, category, content, tags, codeRefs, createdAt, updatedAt FROM knowledge_articles
         WHERE title LIKE ? OR content LIKE ? OR category LIKE ? OR tags LIKE ?`,
        [searchPattern, searchPattern, searchPattern, searchPattern],
      );

      return ok(rows.map((row) => this.mapRowToArticle(row)));
    } catch (error) {
      return err(new StorageError(`Failed to search articles: ${query}`, { cause: error }));
    }
  }

  private async getExistingSlugs(): Promise<Result<Set<string>, StorageError>> {
    try {
      const [rows] = await this.pool.query<RowDataPacket[]>(
        "SELECT slug FROM knowledge_articles",
      );

      const slugs = new Set<string>();
      for (const row of rows) {
        if (typeof row.slug === "string") {
          slugs.add(row.slug);
        }
      }

      return ok(slugs);
    } catch (error) {
      return err(new StorageError("Failed to fetch existing slugs", { cause: error }));
    }
  }

  private mapRowToArticle(row: ArticleRow): KnowledgeArticle {
    return {
      id: articleId(row.id),
      title: row.title,
      slug: row.slug as Slug,
      category: row.category,
      content: row.content,
      tags: this.parseJsonArray(row.tags),
      codeRefs: this.parseJsonArray(row.codeRefs),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private parseJsonArray(json: string | unknown[]): readonly string[] {
    if (Array.isArray(json)) {
      return json as string[];
    }
    try {
      const parsed = JSON.parse(json) as unknown;
      return Array.isArray(parsed) ? (parsed as string[]) : [];
    } catch {
      return [];
    }
  }
}
