import type { Result } from "../core/result.js";
import { err } from "../core/result.js";
import type { NotFoundError, StorageError, ValidationError } from "../core/errors.js";
import { ValidationError as ValidationErrorClass } from "../core/errors.js";
import { slug as brandSlug } from "../core/types.js";
import type { Logger } from "../core/logger.js";
import type { StatusReporter } from "../core/status.js";
import type { KnowledgeArticle, KnowledgeArticleRepository } from "./repository.js";
import type { SearchMutationSync } from "../search/sync.js";
import { validateCreateInput, validateUpdateInput } from "./schemas.js";

export interface KnowledgeServiceDeps {
  knowledgeRepo: KnowledgeArticleRepository;
  logger: Logger;
  searchSync?: SearchMutationSync;
  status?: StatusReporter;
}

export class KnowledgeService {
  private readonly repo: KnowledgeArticleRepository;
  private readonly logger: Logger;
  private readonly searchSync?: SearchMutationSync;
  private readonly status?: StatusReporter;

  constructor(deps: KnowledgeServiceDeps) {
    this.repo = deps.knowledgeRepo;
    this.logger = deps.logger.child({ domain: "knowledge" });
    this.searchSync = deps.searchSync;
    this.status = deps.status;
  }

  async createArticle(
    input: unknown,
  ): Promise<Result<KnowledgeArticle, ValidationError | StorageError>> {
    const validated = validateCreateInput(input);
    if (!validated.ok) return validated;
    this.logger.info("Creating knowledge article", { operation: "createArticle", title: validated.value.title });
    const result = await this.repo.create(validated.value);
    if (result.ok) {
      await this.syncIndexedArticle(result.value.id);
      await this.refreshCounts();
    }
    return result;
  }

  async getArticle(
    id: string,
  ): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    this.logger.debug("Getting knowledge article", { operation: "getArticle", id });
    return this.repo.findById(id);
  }

  async getArticleBySlug(
    slugValue: string,
  ): Promise<Result<KnowledgeArticle, NotFoundError | StorageError>> {
    this.logger.debug("Getting knowledge article by slug", { operation: "getArticleBySlug", slug: slugValue });
    return this.repo.findBySlug(brandSlug(slugValue));
  }

  async updateArticle(
    id: string,
    input: unknown,
  ): Promise<Result<KnowledgeArticle, NotFoundError | ValidationError | StorageError>> {
    const validated = validateUpdateInput(input);
    if (!validated.ok) return validated;
    this.logger.info("Updating knowledge article", { operation: "updateArticle", id });
    const result = await this.repo.update(id, validated.value);
    if (result.ok) {
      await this.syncIndexedArticle(result.value.id);
    }
    return result;
  }

  async deleteArticle(
    id: string,
  ): Promise<Result<void, NotFoundError | StorageError>> {
    this.logger.info("Deleting knowledge article", { operation: "deleteArticle", id });
    const result = await this.repo.delete(id);
    if (result.ok) {
      await this.removeIndexedArticle(id);
      await this.refreshCounts();
    }
    return result;
  }

  async listArticles(
    category?: string,
  ): Promise<Result<KnowledgeArticle[], StorageError>> {
    if (category) {
      this.logger.debug("Listing knowledge articles by category", { operation: "listArticles", category });
      return this.repo.findByCategory(category);
    }
    this.logger.debug("Listing all knowledge articles", { operation: "listArticles" });
    return this.repo.findMany();
  }

  async searchArticles(
    query: string,
  ): Promise<Result<KnowledgeArticle[], ValidationError | StorageError>> {
    if (!query.trim()) {
      return err(new ValidationErrorClass("Search query must not be empty"));
    }
    this.logger.debug("Searching knowledge articles", { operation: "searchArticles", query });
    return this.repo.search(query);
  }

  private async syncIndexedArticle(id: string): Promise<void> {
    if (!this.searchSync) return;
    const syncResult = await this.searchSync.indexKnowledgeArticle(id);
    if (!syncResult.ok) {
      this.logger.warn("Knowledge article indexed with warnings", {
        operation: "indexKnowledgeArticle",
        id,
        error: syncResult.error.message,
      });
    }
  }

  private async removeIndexedArticle(id: string): Promise<void> {
    if (!this.searchSync) return;
    const syncResult = await this.searchSync.removeArticle(id);
    if (!syncResult.ok) {
      this.logger.warn("Knowledge article removal not reflected in search index", {
        operation: "removeKnowledgeArticleFromIndex",
        id,
        error: syncResult.error.message,
      });
    }
  }

  private async refreshCounts(): Promise<void> {
    if (!this.status) return;
    const countResult = await this.repo.findMany();
    if (countResult.ok) {
      this.status.recordStat("knowledgeArticleCount", countResult.value.length);
    }
  }
}
