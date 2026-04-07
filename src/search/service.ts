import type { Result } from "../core/result.js";
import { ok } from "../core/result.js";
import type { NotFoundError, StorageError, ValidationError } from "../core/errors.js";
import type { MonstheraConfig } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import type { SearchIndexRepository, SearchResult, SearchOptions } from "./repository.js";
import type { KnowledgeArticleRepository } from "../knowledge/repository.js";
import type { WorkArticleRepository } from "../work/repository.js";
import type { EmbeddingProvider } from "./embedding.js";
import { validateSearchInput } from "./schemas.js";

// ─── Deps interface ───────────────────────────────────────────────────────────

export interface SearchServiceDeps {
  searchRepo: SearchIndexRepository;
  knowledgeRepo: KnowledgeArticleRepository;
  workRepo: WorkArticleRepository;
  embeddingProvider: EmbeddingProvider;
  config: MonstheraConfig["search"];
  logger: Logger;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class SearchService {
  private readonly searchRepo: SearchIndexRepository;
  private readonly knowledgeRepo: KnowledgeArticleRepository;
  private readonly workRepo: WorkArticleRepository;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly config: MonstheraConfig["search"];
  private readonly logger: Logger;

  constructor(deps: SearchServiceDeps) {
    this.searchRepo = deps.searchRepo;
    this.knowledgeRepo = deps.knowledgeRepo;
    this.workRepo = deps.workRepo;
    this.embeddingProvider = deps.embeddingProvider;
    this.config = deps.config;
    this.logger = deps.logger;
  }

  // ─── search ────────────────────────────────────────────────────────────────

  async search(
    input: unknown,
  ): Promise<Result<SearchResult[], ValidationError | StorageError>> {
    const validated = validateSearchInput(input);
    if (!validated.ok) return validated;

    const options: SearchOptions = {
      ...validated.value,
      semanticEnabled: this.config.semanticEnabled,
    };

    this.logger.debug("Searching articles", { query: validated.value.query, type: validated.value.type });
    return this.searchRepo.search(options);
  }

  // ─── indexKnowledgeArticle ─────────────────────────────────────────────────

  async indexKnowledgeArticle(
    id: string,
  ): Promise<Result<void, NotFoundError | StorageError>> {
    const articleResult = await this.knowledgeRepo.findById(id);
    if (!articleResult.ok) return articleResult;

    const article = articleResult.value;
    const indexContent = this.buildIndexContent(article.content, article.codeRefs);

    this.logger.info("Indexing knowledge article", { id });
    return this.searchRepo.indexArticle(article.id, article.title, indexContent, "knowledge");
  }

  // ─── indexWorkArticle ──────────────────────────────────────────────────────

  async indexWorkArticle(
    id: string,
  ): Promise<Result<void, NotFoundError | StorageError>> {
    const articleResult = await this.workRepo.findById(id);
    if (!articleResult.ok) return articleResult;

    const article = articleResult.value;
    const indexContent = this.buildIndexContent(article.content, article.codeRefs);

    this.logger.info("Indexing work article", { id });
    return this.searchRepo.indexArticle(article.id, article.title, indexContent, "work");
  }

  // ─── removeArticle ─────────────────────────────────────────────────────────

  async removeArticle(id: string): Promise<Result<void, StorageError>> {
    this.logger.info("Removing article from search index", { id });
    return this.searchRepo.removeArticle(id);
  }

  // ─── fullReindex ───────────────────────────────────────────────────────────

  async fullReindex(): Promise<Result<{ knowledgeCount: number; workCount: number }, StorageError>> {
    const knowledgeResult = await this.knowledgeRepo.findMany();
    if (!knowledgeResult.ok) return knowledgeResult;

    const workResult = await this.workRepo.findMany();
    if (!workResult.ok) return workResult;

    const knowledgeArticles = knowledgeResult.value;
    const workArticles = workResult.value;

    // Upsert all source articles in place — never clears the live index.
    // indexArticle has upsert semantics: existing entries are refreshed,
    // new ones are added, and the index stays queryable throughout.
    // Orphan removal (stale entries for deleted articles) is NOT performed
    // here — use removeArticle() explicitly. This avoids race conditions
    // with concurrent writes in a non-transactional environment.
    for (const article of knowledgeArticles) {
      const indexContent = this.buildIndexContent(article.content, article.codeRefs);
      const r = await this.searchRepo.indexArticle(article.id, article.title, indexContent, "knowledge");
      if (!r.ok) return r;
    }

    for (const article of workArticles) {
      const indexContent = this.buildIndexContent(article.content, article.codeRefs);
      const r = await this.searchRepo.indexArticle(article.id, article.title, indexContent, "work");
      if (!r.ok) return r;
    }

    // Rebuild inverted index from current documents
    const reindexResult = await this.searchRepo.reindex();
    if (!reindexResult.ok) return reindexResult;

    this.logger.info("Full reindex complete", {
      knowledgeCount: knowledgeArticles.length,
      workCount: workArticles.length,
    });

    return ok({ knowledgeCount: knowledgeArticles.length, workCount: workArticles.length });
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private buildIndexContent(content: string, codeRefs: readonly string[]): string {
    return codeRefs.length > 0 ? `${content}\n${codeRefs.join(" ")}` : content;
  }
}
