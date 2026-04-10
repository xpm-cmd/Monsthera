import * as fs from "node:fs";
import * as path from "node:path";
import type { KnowledgeArticle } from "../knowledge/repository.js";
import type { WorkArticle } from "../work/repository.js";
import type { Result } from "../core/result.js";
import { ok } from "../core/result.js";
import type { NotFoundError, StorageError, ValidationError } from "../core/errors.js";
import type { MonstheraConfig } from "../core/config.js";
import type { Logger } from "../core/logger.js";
import type { StatusReporter } from "../core/status.js";
import type { RuntimeStateStore } from "../core/runtime-state.js";
import type { SearchIndexRepository, SearchResult, SearchOptions } from "./repository.js";
import type { KnowledgeArticleRepository } from "../knowledge/repository.js";
import type { WorkArticleRepository } from "../work/repository.js";
import type { EmbeddingProvider } from "./embedding.js";
import { validateSearchInput } from "./schemas.js";
import { inspectKnowledgeArticle, inspectWorkArticle } from "../context/insights.js";

export interface ContextPackItem {
  readonly id: string;
  readonly title: string;
  readonly type: "knowledge" | "work";
  readonly score: number;
  readonly searchScore: number;
  readonly reason: string;
  readonly snippet: string;
  readonly updatedAt: string;
  readonly category?: string;
  readonly template?: string;
  readonly phase?: string;
  readonly sourcePath?: string;
  readonly codeRefs: readonly string[];
  readonly staleCodeRefs: readonly string[];
  readonly references?: readonly string[];
  readonly diagnostics: {
    readonly freshness: Awaited<ReturnType<typeof inspectKnowledgeArticle>>["freshness"];
    readonly quality: Awaited<ReturnType<typeof inspectKnowledgeArticle>>["quality"];
  };
}

export interface ContextPack {
  readonly generatedAt: string;
  readonly query: string;
  readonly mode: "general" | "code" | "research";
  readonly summary: {
    readonly itemCount: number;
    readonly knowledgeCount: number;
    readonly workCount: number;
    readonly freshCount: number;
    readonly staleCount: number;
    readonly codeLinkedCount: number;
    readonly sourceLinkedCount: number;
    readonly skippedStaleIndexCount: number;
  };
  readonly guidance: readonly string[];
  readonly items: readonly ContextPackItem[];
}

// ─── Deps interface ───────────────────────────────────────────────────────────

export interface SearchServiceDeps {
  searchRepo: SearchIndexRepository;
  knowledgeRepo: KnowledgeArticleRepository;
  workRepo: WorkArticleRepository;
  embeddingProvider: EmbeddingProvider;
  config: MonstheraConfig["search"];
  logger: Logger;
  status?: StatusReporter;
  runtimeState?: RuntimeStateStore;
  repoPath?: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export class SearchService {
  private readonly searchRepo: SearchIndexRepository;
  private readonly knowledgeRepo: KnowledgeArticleRepository;
  private readonly workRepo: WorkArticleRepository;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly config: MonstheraConfig["search"];
  private readonly logger: Logger;
  private readonly status?: StatusReporter;
  private readonly runtimeState?: RuntimeStateStore;
  private readonly repoPath?: string;

  /** Cached result of the last canary query (null = never ran) */
  private canaryHealthy: boolean | null = null;

  constructor(deps: SearchServiceDeps) {
    this.searchRepo = deps.searchRepo;
    this.knowledgeRepo = deps.knowledgeRepo;
    this.workRepo = deps.workRepo;
    this.embeddingProvider = deps.embeddingProvider;
    this.config = deps.config;
    this.logger = deps.logger.child({ domain: "search" });
    this.status = deps.status;
    this.runtimeState = deps.runtimeState;
    this.repoPath = deps.repoPath;
  }

  // ─── health ────────────────────────────────────────────────────────────────

  /**
   * Returns subsystem health for the status reporter.
   * When the index has documents, the cached canary result determines health.
   * An empty index is considered healthy (nothing to query).
   */
  getHealthStatus(): { healthy: boolean; detail: string } {
    const size = this.searchRepo.size;
    const embeds = this.searchRepo.embeddingCount;
    const semanticTag = embeds > 0 ? `, ${embeds} embeddings` : this.config.semanticEnabled ? ", semantic unavailable" : "";
    if (size === 0) {
      return { healthy: true, detail: `Search service (empty index${semanticTag})` };
    }
    if (this.canaryHealthy === null) {
      return { healthy: true, detail: `Search service (${size} docs, canary pending${semanticTag})` };
    }
    if (this.canaryHealthy) {
      return { healthy: true, detail: `Search service (${size} docs, canary ok${semanticTag})` };
    }
    return { healthy: false, detail: `Search service (${size} docs, canary FAILED — index may need reindex)` };
  }

  /**
   * Run a canary query against the search repository to verify
   * the index can actually return results.
   */
  async runCanary(): Promise<boolean> {
    const healthy = await this.searchRepo.canary();
    this.canaryHealthy = healthy;
    if (!healthy) {
      this.logger.warn("Search canary FAILED: index has documents but queries return empty", {
        operation: "runCanary",
        indexSize: this.searchRepo.size,
      });
    }
    return healthy;
  }

  // ─── search ────────────────────────────────────────────────────────────────

  async search(
    input: unknown,
  ): Promise<Result<SearchResult[], ValidationError | StorageError>> {
    const validated = validateSearchInput(input);
    if (!validated.ok) return validated;

    const { query, type, limit = 20, offset = 0 } = validated.value;
    this.logger.debug("Searching articles", { operation: "search", query, type });

    // BM25 keyword search (always runs)
    const bm25Result = await this.searchRepo.search({ query, type, limit: limit * 3, offset: 0 });
    if (!bm25Result.ok) return bm25Result;

    // If semantic search is not available, return BM25 only
    if (!this.config.semanticEnabled || this.embeddingProvider.dimensions === 0 || this.searchRepo.embeddingCount === 0) {
      const page = bm25Result.value.slice(offset, offset + limit);
      return ok(page);
    }

    // Semantic search: embed the query and find similar docs
    const queryEmbeddingResult = await this.embeddingProvider.embed(query);
    if (!queryEmbeddingResult.ok) {
      this.logger.warn("Semantic embedding failed, falling back to BM25", {
        operation: "search",
        error: queryEmbeddingResult.error.message,
      });
      const page = bm25Result.value.slice(offset, offset + limit);
      return ok(page);
    }

    const semanticResult = await this.searchRepo.searchSemantic(queryEmbeddingResult.value, limit * 3, type);
    if (!semanticResult.ok) {
      const page = bm25Result.value.slice(offset, offset + limit);
      return ok(page);
    }

    // Hybrid merge: normalize BM25 scores and combine with cosine similarity
    const merged = this.mergeResults(bm25Result.value, semanticResult.value, this.config.alpha);

    // Apply offset + limit
    const page = merged.slice(offset, offset + limit);
    return ok(page);
  }

  /**
   * Merge BM25 and semantic results using weighted combination.
   * BM25 scores are normalized to [0,1], cosine similarity is already [0,1].
   * finalScore = alpha * norm_bm25 + (1 - alpha) * cosine
   */
  private mergeResults(
    bm25Results: SearchResult[],
    semanticResults: { id: string; score: number }[],
    alpha: number,
  ): SearchResult[] {
    // Normalize BM25 scores to [0, 1]
    const maxBm25 = bm25Results.reduce((max, r) => Math.max(max, r.score), 0);
    const normFactor = maxBm25 > 0 ? maxBm25 : 1;

    // Build a map of all candidates
    const candidates = new Map<string, { bm25: SearchResult | null; normBm25: number; cosine: number }>();

    for (const r of bm25Results) {
      candidates.set(r.id, { bm25: r, normBm25: r.score / normFactor, cosine: 0 });
    }

    for (const s of semanticResults) {
      const existing = candidates.get(s.id);
      if (existing) {
        existing.cosine = s.score;
      } else {
        // Semantic-only candidate — we need BM25 result data for snippet/title
        // Skip if we don't have it (BM25 provides the display data)
        candidates.set(s.id, { bm25: null, normBm25: 0, cosine: s.score });
      }
    }

    // Score and sort
    const merged: Array<{ result: SearchResult; hybridScore: number }> = [];
    for (const [, entry] of candidates) {
      if (entry.bm25 === null) continue; // can't display without BM25 data (title, snippet)
      const hybridScore = alpha * entry.normBm25 + (1 - alpha) * entry.cosine;
      merged.push({
        result: { ...entry.bm25, score: hybridScore },
        hybridScore,
      });
    }

    merged.sort((a, b) => b.hybridScore - a.hybridScore);
    return merged.map((m) => m.result);
  }

  // ─── indexKnowledgeArticle ─────────────────────────────────────────────────

  async indexKnowledgeArticle(
    id: string,
  ): Promise<Result<void, NotFoundError | StorageError>> {
    const articleResult = await this.knowledgeRepo.findById(id);
    if (!articleResult.ok) return articleResult;

    const article = articleResult.value;
    const indexContent = this.buildIndexContent(article.content, article.codeRefs);

    this.logger.info("Indexing knowledge article", { operation: "indexKnowledgeArticle", id });
    const indexResult = await this.searchRepo.indexArticle(article.id, article.title, indexContent, "knowledge");
    if (!indexResult.ok) return indexResult;

    await this.generateAndStoreEmbedding(article.id, article.title, indexContent);
    return indexResult;
  }

  // ─── indexWorkArticle ──────────────────────────────────────────────────────

  async indexWorkArticle(
    id: string,
  ): Promise<Result<void, NotFoundError | StorageError>> {
    const articleResult = await this.workRepo.findById(id);
    if (!articleResult.ok) return articleResult;

    const article = articleResult.value;
    const indexContent = this.buildIndexContent(article.content, article.codeRefs);

    this.logger.info("Indexing work article", { operation: "indexWorkArticle", id });
    const indexResult = await this.searchRepo.indexArticle(article.id, article.title, indexContent, "work");
    if (!indexResult.ok) return indexResult;

    await this.generateAndStoreEmbedding(article.id, article.title, indexContent);
    return indexResult;
  }

  // ─── removeArticle ─────────────────────────────────────────────────────────

  async removeArticle(id: string): Promise<Result<void, StorageError>> {
    this.logger.info("Removing article from search index", { operation: "removeArticle", id });
    return this.searchRepo.removeArticle(id);
  }

  // ─── fullReindex ───────────────────────────────────────────────────────────

  async fullReindex(): Promise<Result<{ knowledgeCount: number; workCount: number }, StorageError>> {
    const startTime = Date.now();
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

    // Generate embeddings for semantic search (if enabled and provider is healthy)
    if (this.config.semanticEnabled && this.embeddingProvider.dimensions > 0) {
      const healthResult = await this.embeddingProvider.healthCheck();
      if (healthResult.ok) {
        const total = knowledgeArticles.length + workArticles.length;
        this.logger.info("Generating embeddings for semantic search", {
          operation: "fullReindex",
          totalArticles: total,
          model: this.embeddingProvider.modelName,
        });
        for (const article of knowledgeArticles) {
          const indexContent = this.buildIndexContent(article.content, article.codeRefs);
          await this.generateAndStoreEmbedding(article.id, article.title, indexContent);
        }
        for (const article of workArticles) {
          const indexContent = this.buildIndexContent(article.content, article.codeRefs);
          await this.generateAndStoreEmbedding(article.id, article.title, indexContent);
        }
        this.status?.recordStat("semanticSearchEnabled", true);
        this.status?.recordStat("embeddingCount", this.searchRepo.embeddingCount);
      } else {
        this.logger.warn("Semantic search unavailable — embedding provider not ready, using BM25 only", {
          operation: "fullReindex",
          error: healthResult.error.message,
        });
        this.status?.recordStat("semanticSearchEnabled", false);
      }
    }

    const durationMs = Date.now() - startTime;
    this.status?.recordStat("knowledgeArticleCount", knowledgeArticles.length);
    this.status?.recordStat("workArticleCount", workArticles.length);
    this.status?.recordStat("searchIndexSize", knowledgeArticles.length + workArticles.length);
    const reindexedAt = new Date().toISOString();
    this.status?.recordStat("lastReindexAt", reindexedAt);
    if (this.runtimeState) {
      await this.runtimeState.write({
        knowledgeArticleCount: knowledgeArticles.length,
        workArticleCount: workArticles.length,
        searchIndexSize: knowledgeArticles.length + workArticles.length,
        lastReindexAt: reindexedAt,
      });
    }
    this.logger.info("Full reindex complete", {
      operation: "fullReindex",
      knowledgeCount: knowledgeArticles.length,
      workCount: workArticles.length,
      durationMs,
    });

    await this.runCanary();

    return ok({ knowledgeCount: knowledgeArticles.length, workCount: workArticles.length });
  }

  async buildContextPack(
    input: unknown,
  ): Promise<Result<ContextPack, ValidationError | StorageError>> {
    const validated = validateSearchInput(input);
    if (!validated.ok) return validated;

    const mode = isContextPackMode((input as { mode?: unknown })?.mode)
      ? (input as { mode: "general" | "code" | "research" }).mode
      : "general";
    const requestedLimit = typeof validated.value.limit === "number" ? validated.value.limit : 8;
    const limit = Math.max(1, Math.min(requestedLimit, 20));
    const candidateLimit = Math.max(limit * 3, 12);
    const searchResult = await this.search({
      query: validated.value.query,
      type: validated.value.type,
      limit: candidateLimit,
      offset: validated.value.offset,
    });
    if (!searchResult.ok) return searchResult;

    const items: ContextPackItem[] = [];
    let skippedStaleIndexCount = 0;

    for (const hit of searchResult.value) {
      if (hit.type === "knowledge") {
        const articleResult = await this.knowledgeRepo.findById(hit.id);
        if (!articleResult.ok) {
          if ((articleResult.error as NotFoundError).code === "NOT_FOUND") {
            skippedStaleIndexCount += 1;
            continue;
          }
          return articleResult;
        }
        const diagnostics = await inspectKnowledgeArticle(articleResult.value, { repoPath: this.repoPath });
        items.push(this.buildKnowledgeContextItem(hit, articleResult.value, diagnostics, mode));
        continue;
      }

      const articleResult = await this.workRepo.findById(hit.id);
      if (!articleResult.ok) {
        if ((articleResult.error as NotFoundError).code === "NOT_FOUND") {
          skippedStaleIndexCount += 1;
          continue;
        }
        return articleResult;
      }
      const diagnostics = inspectWorkArticle(articleResult.value);
      items.push(this.buildWorkContextItem(hit, articleResult.value, diagnostics, mode));
    }

    items.sort((left, right) => right.score - left.score);
    const page = items.slice(0, limit);
    const freshCount = page.filter((item) => item.diagnostics.freshness.state === "fresh").length;
    const staleCount = page.filter((item) => item.diagnostics.freshness.state === "stale").length;
    const codeLinkedCount = page.filter((item) => item.codeRefs.length > 0).length;
    const sourceLinkedCount = page.filter((item) => Boolean(item.sourcePath)).length;
    const knowledgeCount = page.filter((item) => item.type === "knowledge").length;
    const workCount = page.length - knowledgeCount;

    return ok({
      generatedAt: new Date().toISOString(),
      query: validated.value.query,
      mode,
      summary: {
        itemCount: page.length,
        knowledgeCount,
        workCount,
        freshCount,
        staleCount,
        codeLinkedCount,
        sourceLinkedCount,
        skippedStaleIndexCount,
      },
      guidance: guidanceForMode(mode, {
        freshCount,
        staleCount,
        sourceLinkedCount,
        codeLinkedCount,
      }),
      items: page,
    });
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Generate an embedding for a document and store it.
   * Silently skips if semantic search is disabled or provider is a stub.
   */
  private async generateAndStoreEmbedding(id: string, title: string, content: string): Promise<void> {
    if (!this.config.semanticEnabled || this.embeddingProvider.dimensions === 0) return;

    // Embed a concise representation: title + first ~500 chars of content
    const text = `${title}\n${content.slice(0, 500)}`;
    const result = await this.embeddingProvider.embed(text);
    if (!result.ok) {
      this.logger.warn("Failed to generate embedding", { operation: "generateEmbedding", id, error: result.error.message });
      return;
    }
    await this.searchRepo.storeEmbedding(id, result.value);
  }

  private validateCodeRefs(codeRefs: readonly string[]): { valid: readonly string[]; stale: readonly string[] } {
    if (!this.repoPath || codeRefs.length === 0) {
      return { valid: codeRefs, stale: [] };
    }
    const valid: string[] = [];
    const stale: string[] = [];
    for (const ref of codeRefs) {
      const resolved = path.resolve(this.repoPath, ref);
      if (fs.existsSync(resolved)) {
        valid.push(ref);
      } else {
        stale.push(ref);
      }
    }
    return { valid, stale };
  }

  private buildIndexContent(content: string, codeRefs: readonly string[]): string {
    return codeRefs.length > 0 ? `${content}\n${codeRefs.join(" ")}` : content;
  }

  private buildKnowledgeContextItem(
    hit: { id: string; title: string; score: number; snippet: string; type: "knowledge" | "work" },
    article: KnowledgeArticle,
    diagnostics: Awaited<ReturnType<typeof inspectKnowledgeArticle>>,
    mode: "general" | "code" | "research",
  ): ContextPackItem {
    const { valid: codeRefs, stale: staleCodeRefs } = this.validateCodeRefs(article.codeRefs);
    const score = scoreContextPackItem({
      baseScore: hit.score,
      qualityScore: diagnostics.quality.score,
      freshness: diagnostics.freshness.state,
      mode,
      type: "knowledge",
      codeRefCount: codeRefs.length,
      referenceCount: 0,
      sourcePath: article.sourcePath,
      category: article.category,
      template: undefined,
      phase: undefined,
    });
    return {
      id: article.id,
      title: article.title,
      type: "knowledge",
      score,
      searchScore: hit.score,
      reason: buildReason({
        mode,
        freshness: diagnostics.freshness,
        quality: diagnostics.quality,
        codeRefCount: codeRefs.length,
        referenceCount: 0,
        sourcePath: article.sourcePath,
        type: "knowledge",
      }),
      snippet: hit.snippet,
      updatedAt: article.updatedAt,
      category: article.category,
      sourcePath: article.sourcePath,
      codeRefs,
      staleCodeRefs,
      diagnostics: {
        freshness: diagnostics.freshness,
        quality: diagnostics.quality,
      },
    };
  }

  private buildWorkContextItem(
    hit: { id: string; title: string; score: number; snippet: string; type: "knowledge" | "work" },
    article: WorkArticle,
    diagnostics: ReturnType<typeof inspectWorkArticle>,
    mode: "general" | "code" | "research",
  ): ContextPackItem {
    const { valid: codeRefs, stale: staleCodeRefs } = this.validateCodeRefs(article.codeRefs);
    const score = scoreContextPackItem({
      baseScore: hit.score,
      qualityScore: diagnostics.quality.score,
      freshness: diagnostics.freshness.state,
      mode,
      type: "work",
      codeRefCount: codeRefs.length,
      referenceCount: article.references.length,
      sourcePath: undefined,
      category: undefined,
      template: article.template,
      phase: article.phase,
    });
    return {
      id: article.id,
      title: article.title,
      type: "work",
      score,
      searchScore: hit.score,
      reason: buildReason({
        mode,
        freshness: diagnostics.freshness,
        quality: diagnostics.quality,
        codeRefCount: codeRefs.length,
        referenceCount: article.references.length,
        sourcePath: undefined,
        type: "work",
      }),
      snippet: hit.snippet,
      updatedAt: article.updatedAt,
      template: article.template,
      phase: article.phase,
      codeRefs,
      staleCodeRefs,
      references: article.references,
      diagnostics: {
        freshness: diagnostics.freshness,
        quality: diagnostics.quality,
      },
    };
  }
}

function isContextPackMode(value: unknown): value is "general" | "code" | "research" {
  return value === "general" || value === "code" || value === "research";
}

function scoreContextPackItem(input: {
  baseScore: number;
  qualityScore: number;
  freshness: "fresh" | "attention" | "stale" | "unknown";
  mode: "general" | "code" | "research";
  type: "knowledge" | "work";
  codeRefCount: number;
  referenceCount: number;
  sourcePath?: string;
  category?: string;
  template?: string;
  phase?: string;
}): number {
  let total = input.baseScore;
  total += input.qualityScore / 40;
  total += input.freshness === "fresh" ? 0.5 : input.freshness === "attention" ? 0.2 : input.freshness === "unknown" ? 0.1 : -0.25;

  if (input.mode === "code") {
    total += Math.min(1.2, input.codeRefCount * 0.35);
    if (input.type === "knowledge" && ["architecture", "engineering", "solution", "runbook"].includes((input.category ?? "").toLowerCase())) total += 0.4;
    if (input.type === "work" && ["feature", "bugfix", "refactor"].includes(input.template ?? "")) total += 0.35;
    if (input.phase === "implementation" || input.phase === "review") total += 0.2;
  }

  if (input.mode === "research") {
    total += Math.min(0.8, input.referenceCount * 0.2);
    if (input.sourcePath) total += 0.5;
    if (input.type === "knowledge" && ["guide", "context", "solution", "runbook", "research"].includes((input.category ?? "").toLowerCase())) total += 0.4;
    if (input.template === "spike") total += 0.8;
    if (input.phase === "planning" || input.phase === "enrichment") total += 0.2;
  }

  return Number(total.toFixed(3));
}

function buildReason(input: {
  mode: "general" | "code" | "research";
  freshness: { state: "fresh" | "attention" | "stale" | "unknown"; detail: string };
  quality: { label: string };
  codeRefCount: number;
  referenceCount: number;
  sourcePath?: string;
  type: "knowledge" | "work";
}): string {
  const reasons: string[] = [];
  reasons.push(`${input.quality.label} quality`);
  if (input.codeRefCount > 0) reasons.push(`${input.codeRefCount} code ref(s)`);
  if (input.referenceCount > 0) reasons.push(`${input.referenceCount} linked reference(s)`);
  if (input.sourcePath) reasons.push("linked source path");
  if (input.mode === "code" && input.codeRefCount === 0) reasons.push("useful contract even without direct code refs");
  if (input.mode === "research" && !input.sourcePath && input.referenceCount === 0) reasons.push("good conceptual context");
  reasons.push(input.freshness.state === "fresh" ? "fresh context" : input.freshness.state === "stale" ? "needs refresh review" : "usable context");
  return reasons.join(" · ");
}

function guidanceForMode(
  mode: "general" | "code" | "research",
  summary: { freshCount: number; staleCount: number; sourceLinkedCount: number; codeLinkedCount: number },
): string[] {
  const guidance: string[] = [];
  if (mode === "code") {
    guidance.push("Start with the highest-ranked code-linked items to minimize blind repository scanning.");
    guidance.push(summary.codeLinkedCount > 0 ? "Prefer entries with code refs before expanding into full-file reads." : "Add code refs to key knowledge/work items to improve future code generation packs.");
  } else if (mode === "research") {
    guidance.push("Start with source-linked or richer knowledge items before reading implementation details.");
    guidance.push(summary.sourceLinkedCount > 0 ? "Use source-linked notes to keep investigations fresh and auditable." : "Imported source-linked knowledge would strengthen future investigation packs.");
  } else {
    guidance.push("Read the freshest, highest-quality items first before widening the context window.");
  }

  if (summary.staleCount > 0) {
    guidance.push("Some recommended items are stale; refresh or validate them before using them as final truth.");
  } else if (summary.freshCount > 0) {
    guidance.push("This pack already contains fresh context, so you can plan with less rediscovery.");
  }

  return guidance;
}
