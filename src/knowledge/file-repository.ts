import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { NotFoundError, StorageError } from "../core/errors.js";
import type { ValidationError } from "../core/errors.js";
import { generateArticleId, articleId, slug, timestamp } from "../core/types.js";
import type { ArticleId, Slug } from "../core/types.js";
import { parseMarkdown, serializeMarkdown } from "./markdown.js";
import { uniqueSlug } from "./slug.js";
import { validateFrontmatter } from "./schemas.js";
import type {
  KnowledgeArticle,
  KnowledgeArticleRepository,
  CreateKnowledgeArticleInput,
  UpdateKnowledgeArticleInput,
} from "./repository.js";

export class FileSystemKnowledgeArticleRepository implements KnowledgeArticleRepository {
  constructor(private readonly markdownRoot: string) {}

  private get notesDir(): string {
    return path.join(this.markdownRoot, "notes");
  }

  private articlePath(slugValue: string): string {
    return path.join(this.notesDir, `${slugValue}.md`);
  }

  private async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.notesDir, { recursive: true });
  }

  private async readFromPath(filePath: string): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return err(new NotFoundError("KnowledgeArticle", path.basename(filePath, ".md")));
      }
      return err(new StorageError(`Failed to read knowledge article: ${filePath}`, { cause: String(error) }));
    }

    const parsed = parseMarkdown(raw);
    if (!parsed.ok) {
      return err(new StorageError(`Failed to parse knowledge article markdown: ${filePath}`, { cause: parsed.error.message }));
    }

    const frontmatter = validateFrontmatter(parsed.value.frontmatter);
    if (!frontmatter.ok) {
      return err(new StorageError(`Invalid knowledge article frontmatter: ${filePath}`, { cause: frontmatter.error.message }));
    }

    return ok({
      id: articleId(frontmatter.value.id),
      title: frontmatter.value.title,
      slug: slug(frontmatter.value.slug),
      category: frontmatter.value.category,
      tags: frontmatter.value.tags,
      codeRefs: frontmatter.value.codeRefs,
      createdAt: timestamp(frontmatter.value.createdAt),
      updatedAt: timestamp(frontmatter.value.updatedAt),
      content: parsed.value.body,
    });
  }

  private async loadAll(): Promise<Result<KnowledgeArticle[], StorageError>> {
    await this.ensureDirectory();

    let entries: string[];
    try {
      entries = await fs.readdir(this.notesDir);
    } catch (error) {
      return err(new StorageError(`Failed to list knowledge articles in ${this.notesDir}`, { cause: String(error) }));
    }

    const articles: KnowledgeArticle[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const articleResult = await this.readFromPath(path.join(this.notesDir, entry));
      if (!articleResult.ok) {
        if (articleResult.error instanceof NotFoundError) continue;
        return articleResult;
      }
      articles.push(articleResult.value);
    }

    return ok(articles);
  }

  private async writeArticle(article: KnowledgeArticle, previousSlug?: Slug): Promise<Result<KnowledgeArticle, StorageError>> {
    await this.ensureDirectory();

    const frontmatter = {
      id: article.id,
      title: article.title,
      slug: article.slug,
      category: article.category,
      tags: [...article.tags],
      codeRefs: [...article.codeRefs],
      createdAt: article.createdAt,
      updatedAt: article.updatedAt,
    };

    try {
      await fs.writeFile(this.articlePath(article.slug), serializeMarkdown(frontmatter, article.content), "utf-8");
      if (previousSlug && previousSlug !== article.slug) {
        await fs.rm(this.articlePath(previousSlug), { force: true });
      }
      return ok(article);
    } catch (error) {
      return err(new StorageError(`Failed to write knowledge article: ${article.id}`, { cause: String(error) }));
    }
  }

  async findById(id: string): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;
    const article = allResult.value.find((candidate) => candidate.id === id);
    if (!article) return err(new NotFoundError("KnowledgeArticle", id));
    return ok(article);
  }

  async findMany(_filter?: Record<string, unknown>): Promise<Result<KnowledgeArticle[], StorageError>> {
    return this.loadAll();
  }

  async create(input: CreateKnowledgeArticleInput): Promise<Result<KnowledgeArticle, ValidationError | StorageError>> {
    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;

    const articleSlug = uniqueSlug(
      input.title,
      new Set(allResult.value.map((article) => article.slug)),
    );
    const now = timestamp();

    const article: KnowledgeArticle = {
      id: generateArticleId() as ArticleId,
      title: input.title,
      slug: articleSlug,
      category: input.category,
      content: input.content,
      tags: input.tags ?? [],
      codeRefs: input.codeRefs ?? [],
      createdAt: now,
      updatedAt: now,
    };

    return this.writeArticle(article);
  }

  async update(
    id: string,
    input: UpdateKnowledgeArticleInput,
  ): Promise<Result<KnowledgeArticle, NotFoundError | ValidationError | StorageError>> {
    const existingResult = await this.findById(id);
    if (!existingResult.ok) return existingResult;

    const existing = existingResult.value;
    let nextSlug = existing.slug;

    if (input.title !== undefined && input.title !== existing.title) {
      const allResult = await this.loadAll();
      if (!allResult.ok) return allResult;
      const existingSlugs = new Set(
        allResult.value
          .filter((article) => article.id !== id)
          .map((article) => article.slug),
      );
      nextSlug = uniqueSlug(input.title, existingSlugs);
    }

    const updated: KnowledgeArticle = {
      ...existing,
      title: input.title ?? existing.title,
      slug: nextSlug,
      category: input.category ?? existing.category,
      content: input.content ?? existing.content,
      tags: input.tags ?? existing.tags,
      codeRefs: input.codeRefs ?? existing.codeRefs,
      updatedAt: timestamp(),
    };

    return this.writeArticle(updated, existing.slug);
  }

  async delete(id: string): Promise<Result<void, NotFoundError | StorageError>> {
    const existingResult = await this.findById(id);
    if (!existingResult.ok) return existingResult;

    try {
      await fs.rm(this.articlePath(existingResult.value.slug), { force: true });
      return ok(undefined);
    } catch (error) {
      return err(new StorageError(`Failed to delete knowledge article: ${id}`, { cause: String(error) }));
    }
  }

  async exists(id: string): Promise<boolean> {
    const result = await this.findById(id);
    return result.ok;
  }

  async findBySlug(slugValue: Slug): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    const result = await this.readFromPath(this.articlePath(slugValue));
    if (!result.ok && result.error instanceof NotFoundError) {
      return err(new NotFoundError("KnowledgeArticle", `slug:${slugValue}`));
    }
    return result;
  }

  async findByCategory(category: string): Promise<Result<KnowledgeArticle[], StorageError>> {
    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;
    const normalized = category.toLowerCase();
    return ok(allResult.value.filter((article) => article.category.toLowerCase() === normalized));
  }

  async findByTag(tag: string): Promise<Result<KnowledgeArticle[], StorageError>> {
    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;
    return ok(allResult.value.filter((article) => article.tags.includes(tag)));
  }

  async search(query: string): Promise<Result<KnowledgeArticle[], StorageError>> {
    const allResult = await this.loadAll();
    if (!allResult.ok) return allResult;
    const normalized = query.toLowerCase();
    return ok(
      allResult.value.filter((article) =>
        article.title.toLowerCase().includes(normalized) ||
        article.content.toLowerCase().includes(normalized) ||
        article.category.toLowerCase().includes(normalized) ||
        article.tags.some((tag) => tag.toLowerCase().includes(normalized)),
      ),
    );
  }
}
