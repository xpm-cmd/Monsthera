import type { Result } from "../core/result.js";
import { err, ok } from "../core/result.js";
import type { NotFoundError, StorageError, ValidationError, AlreadyExistsError } from "../core/errors.js";
import { AlreadyExistsError as AlreadyExistsErrorClass, ValidationError as ValidationErrorClass } from "../core/errors.js";
import { slug as brandSlug } from "../core/types.js";
import type { Logger } from "../core/logger.js";
import type { StatusReporter } from "../core/status.js";
import type { KnowledgeArticle, KnowledgeArticleRepository } from "./repository.js";
import type { SearchMutationSync } from "../search/sync.js";
import type { WikiBookkeeper } from "./wiki-bookkeeper.js";
import { validateCreateInput, validateUpdateInput } from "./schemas.js";
import { toSlug } from "./slug.js";
import { nearMissConflicts } from "./slug-conflict.js";

export interface KnowledgeServiceDeps {
  knowledgeRepo: KnowledgeArticleRepository;
  logger: Logger;
  searchSync?: SearchMutationSync;
  status?: StatusReporter;
  bookkeeper?: WikiBookkeeper;
}

export class KnowledgeService {
  private readonly repo: KnowledgeArticleRepository;
  private readonly logger: Logger;
  private readonly searchSync?: SearchMutationSync;
  private readonly status?: StatusReporter;
  readonly bookkeeper?: WikiBookkeeper;

  constructor(deps: KnowledgeServiceDeps) {
    this.repo = deps.knowledgeRepo;
    this.logger = deps.logger.child({ domain: "knowledge" });
    this.searchSync = deps.searchSync;
    this.status = deps.status;
    this.bookkeeper = deps.bookkeeper;
  }

  async createArticle(
    input: unknown,
  ): Promise<Result<KnowledgeArticle, ValidationError | AlreadyExistsError | StorageError>> {
    const validated = validateCreateInput(input);
    if (!validated.ok) return validated;

    // If an explicit slug was supplied, verify it does not collide with an existing article.
    // The schema has already enforced ^[a-z0-9-]+$, so we only need to check uniqueness here.
    if (validated.value.slug !== undefined) {
      const existing = await this.repo.findBySlug(brandSlug(validated.value.slug));
      if (existing.ok) {
        return err(
          new AlreadyExistsErrorClass(
            "KnowledgeArticle",
            `slug:${validated.value.slug} — call preview_slug first to pick an available slug`,
          ),
        );
      }
      // Any non-ok result other than NOT_FOUND surfaces as a storage error below.
      if (existing.error.code !== "NOT_FOUND") {
        return err(existing.error);
      }
    }

    this.logger.info("Creating knowledge article", { operation: "createArticle", title: validated.value.title });
    // Pass slug through to repo (branded) when supplied; otherwise repo auto-generates.
    const repoInput = {
      ...validated.value,
      slug: validated.value.slug !== undefined ? brandSlug(validated.value.slug) : undefined,
    };
    const result = await this.repo.create(repoInput);
    if (result.ok) {
      await this.syncIndexedArticle(result.value.id);
      await this.refreshCounts();
      await this.bookkeeper?.appendLog("create", "knowledge", result.value.title, result.value.id);
      await this.rebuildIndex();
    }
    return result;
  }

  /**
   * Preview the slug that would be generated for a given title.
   * Read-only — does not mutate state.
   *
   * Returns `{ slug, alreadyExists, conflicts }` where `conflicts` is a list of
   * near-miss slugs (Jaccard similarity >= 0.7 on hyphen-split tokens) that
   * sibling articles may have authored inline wikilinks against. An empty
   * array means no near-miss was found and the caller may proceed with
   * confidence.
   */
  async previewSlug(
    title: string,
  ): Promise<Result<{ slug: string; alreadyExists: boolean; conflicts: string[] }, StorageError>> {
    this.logger.debug("Previewing slug", { operation: "previewSlug", title });
    const target = toSlug(title);
    const all = await this.repo.findMany();
    if (!all.ok) return err(all.error);
    const existingSlugs = all.value.map((a) => a.slug as string);
    const alreadyExists = existingSlugs.includes(target);
    const conflicts = nearMissConflicts(target, existingSlugs);
    return ok({ slug: target as string, alreadyExists, conflicts });
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
      await this.bookkeeper?.appendLog("update", "knowledge", result.value.title, result.value.id);
      await this.rebuildIndex();
    }
    return result;
  }

  async deleteArticle(
    id: string,
  ): Promise<Result<void, NotFoundError | StorageError>> {
    this.logger.info("Deleting knowledge article", { operation: "deleteArticle", id });
    // Capture title before deletion for log
    const existing = await this.repo.findById(id);
    const title = existing.ok ? existing.value.title : id;
    const result = await this.repo.delete(id);
    if (result.ok) {
      await this.removeIndexedArticle(id);
      await this.refreshCounts();
      await this.bookkeeper?.appendLog("delete", "knowledge", title, id);
      await this.rebuildIndex();
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

  /** Rebuild index.md from current articles. Requires workRepo via bookkeeper. */
  private async rebuildIndex(): Promise<void> {
    if (!this.bookkeeper || !this._workRepoRef) return;
    const knowledge = await this.repo.findMany();
    if (!knowledge.ok) return;
    const work = await this._workRepoRef.findMany();
    if (!work.ok) return;
    await this.bookkeeper.rebuildIndex(knowledge.value, work.value);
  }

  /** Set by container after both services are created. */
  private _workRepoRef?: { findMany(): Promise<import("../core/result.js").Result<import("../work/repository.js").WorkArticle[], import("../core/errors.js").StorageError>> };
  setWorkRepo(workRepo: typeof this._workRepoRef): void {
    this._workRepoRef = workRepo;
  }
}
