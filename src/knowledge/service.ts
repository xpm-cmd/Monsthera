import type { Result } from "../core/result.js";
import { err } from "../core/result.js";
import type { NotFoundError, StorageError, ValidationError } from "../core/errors.js";
import { ValidationError as ValidationErrorClass } from "../core/errors.js";
import { slug as brandSlug } from "../core/types.js";
import type { Logger } from "../core/logger.js";
import type { KnowledgeArticle, KnowledgeArticleRepository } from "./repository.js";
import { validateCreateInput, validateUpdateInput } from "./schemas.js";

export interface KnowledgeServiceDeps {
  knowledgeRepo: KnowledgeArticleRepository;
  logger: Logger;
}

export class KnowledgeService {
  private readonly repo: KnowledgeArticleRepository;
  private readonly logger: Logger;

  constructor(deps: KnowledgeServiceDeps) {
    this.repo = deps.knowledgeRepo;
    this.logger = deps.logger;
  }

  async createArticle(
    input: unknown,
  ): Promise<Result<KnowledgeArticle, ValidationError | StorageError>> {
    const validated = validateCreateInput(input);
    if (!validated.ok) return validated;
    this.logger.info("Creating knowledge article", { title: validated.value.title });
    return this.repo.create(validated.value);
  }

  async getArticle(
    id: string,
  ): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    this.logger.debug("Getting knowledge article", { id });
    return this.repo.findById(id);
  }

  async getArticleBySlug(
    slugValue: string,
  ): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    this.logger.debug("Getting knowledge article by slug", { slug: slugValue });
    return this.repo.findBySlug(brandSlug(slugValue));
  }

  async updateArticle(
    id: string,
    input: unknown,
  ): Promise<Result<KnowledgeArticle, NotFoundError | ValidationError | StorageError>> {
    const validated = validateUpdateInput(input);
    if (!validated.ok) return validated;
    this.logger.info("Updating knowledge article", { id });
    return this.repo.update(id, validated.value);
  }

  async deleteArticle(
    id: string,
  ): Promise<Result<void, NotFoundError | StorageError>> {
    this.logger.info("Deleting knowledge article", { id });
    return this.repo.delete(id);
  }

  async listArticles(
    category?: string,
  ): Promise<Result<KnowledgeArticle[], StorageError>> {
    if (category) {
      this.logger.debug("Listing knowledge articles by category", { category });
      return this.repo.findByCategory(category);
    }
    this.logger.debug("Listing all knowledge articles");
    return this.repo.findMany();
  }

  async searchArticles(
    query: string,
  ): Promise<Result<KnowledgeArticle[], ValidationError | StorageError>> {
    if (!query.trim()) {
      return err(new ValidationErrorClass("Search query must not be empty"));
    }
    this.logger.debug("Searching knowledge articles", { query });
    return this.repo.search(query);
  }
}
