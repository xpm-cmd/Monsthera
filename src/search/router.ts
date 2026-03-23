import type { Database as DatabaseType } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { SearchBackend, SearchBackendName, SearchResult } from "./interface.js";
import { FTS5Backend, type KnowledgeFtsResult, type TicketFtsResult } from "./fts5.js";
import { ZoektBackend } from "./zoekt.js";
import { SemanticReranker, mergeResults, buildEmbeddingText } from "./semantic.js";
import { DEFAULT_SEARCH_CONFIG, type SearchConfigShape } from "./constants.js";
import { getIndexedCommit } from "../indexing/indexer.js";
import { getHead } from "../git/operations.js";

export interface SearchRouterOptions {
  repoId: number;
  sqlite: DatabaseType;
  db: BetterSQLite3Database<typeof schema>;
  repoPath: string;
  zoektEnabled: boolean;
  semanticEnabled: boolean;
  indexDir: string;
  onFallback?: (reason: string) => void;
  searchConfig?: SearchConfigShape;
}

/**
 * Routes search queries to the best available backend.
 * Tries Zoekt first (if enabled), falls back to FTS5.
 * Optionally re-ranks results via semantic similarity.
 */
export class SearchRouter {
  private fts5: FTS5Backend;
  private zoekt: ZoektBackend | null;
  private semantic: SemanticReranker | null;
  private activeBackend: SearchBackend | null = null;
  private searchConfig: SearchConfigShape;

  constructor(private opts: SearchRouterOptions) {
    this.searchConfig = opts.searchConfig ?? DEFAULT_SEARCH_CONFIG;
    this.fts5 = new FTS5Backend(opts.sqlite, opts.db, (reason) => opts.onFallback?.(reason), this.searchConfig);
    this.zoekt = opts.zoektEnabled ? new ZoektBackend(opts.repoPath, opts.indexDir) : null;
    this.semantic = opts.semanticEnabled
      ? new SemanticReranker({
          sqlite: opts.sqlite,
          db: opts.db,
          onFallback: opts.onFallback,
          searchConfig: this.searchConfig,
        })
      : null;
  }

  async initialize(): Promise<void> {
    this.fts5.initFtsTable();
    // Initialize knowledge FTS for repo DB
    this.fts5.initKnowledgeFts(this.opts.sqlite);
    this.fts5.initTicketFts();

    let indexedCommit: string | null = null;
    try {
      indexedCommit = getIndexedCommit(this.opts.db, this.opts.repoId);
    } catch {
      indexedCommit = null;
    }
    let head: string | null = null;
    try {
      head = await getHead({ cwd: this.opts.repoPath });
    } catch {
      head = null;
    }
    const repoIndexCurrent = Boolean(indexedCommit && head && indexedCommit === head);

    if (!repoIndexCurrent || !this.fts5.isFileIndexCurrent(this.opts.repoId)) {
      this.fts5.rebuildIndex(this.opts.repoId);
    }
    if (!repoIndexCurrent || !this.fts5.isKnowledgeIndexCurrent(this.opts.sqlite)) {
      this.fts5.rebuildKnowledgeFts(this.opts.sqlite);
    }
    if (!repoIndexCurrent || !this.fts5.isTicketIndexCurrent(this.opts.repoId)) {
      this.fts5.rebuildTicketFts(this.opts.repoId);
    }

    if (this.zoekt && (await this.zoekt.isAvailable())) {
      this.activeBackend = this.zoekt;
    } else {
      if (this.zoekt) {
        this.opts.onFallback?.("Zoekt unavailable, using FTS5 fallback");
      }
      this.activeBackend = this.fts5;
    }

    // Initialize semantic reranker (lazy model load)
    if (this.semantic) {
      const ok = await this.semantic.initialize();
      if (!ok) {
        this.opts.onFallback?.("Semantic model failed to load, disabling semantic re-ranking");
        this.semantic = null;
      } else {
        // Backfill embeddings for files indexed before semantic was available.
        // Runs in background so it doesn't block startup.
        this.backfillEmbeddings(this.opts.repoId).catch(() => {});
      }
    }
  }

  /**
   * Generate embeddings for files and knowledge entries that were indexed
   * before the semantic model was available (embedding IS NULL).
   * Non-blocking: errors are silently ignored per-row.
   */
  private async backfillEmbeddings(repoId: number): Promise<void> {
    if (!this.semantic?.isAvailable()) return;

    let totalBackfilled = 0;

    // --- File embeddings ---
    const files = this.opts.sqlite
      .prepare("SELECT id, path, language, summary, symbols_json FROM files WHERE repo_id = ? AND embedding IS NULL")
      .all(repoId) as Array<{ id: number; path: string; language: string | null; summary: string | null; symbols_json: string | null }>;

    for (const file of files) {
      try {
        const text = buildEmbeddingText({
          path: file.path,
          language: file.language,
          summary: file.summary ?? "",
          symbolsJson: file.symbols_json ?? "[]",
        });
        const embedding = await this.semantic.embed(text);
        if (embedding) {
          this.semantic.storeEmbedding(file.id, embedding);
          totalBackfilled++;
        }
      } catch {
        // Non-fatal: skip this file
      }
    }

    // --- Knowledge embeddings (repo DB) ---
    totalBackfilled += await this.backfillKnowledgeEmbeddings(this.opts.sqlite);

    if (totalBackfilled > 0) {
      this.opts.onFallback?.(`Backfilled ${totalBackfilled} embeddings`);
    }
  }

  /** Backfill knowledge entries missing embeddings in a given sqlite handle. */
  async backfillKnowledgeEmbeddings(sqlite: DatabaseType): Promise<number> {
    if (!this.semantic?.isAvailable()) return 0;

    let rows: Array<{ id: number; title: string; content: string }>;
    try {
      rows = sqlite
        .prepare("SELECT id, title, content FROM knowledge WHERE embedding IS NULL AND status = 'active'")
        .all() as typeof rows;
    } catch {
      return 0; // table may not exist
    }

    let count = 0;
    for (const row of rows) {
      try {
        const embedding = await this.semantic.embed(`${row.title}. ${row.content}`);
        if (embedding) {
          this.semantic.storeKnowledgeEmbedding(sqlite, row.id, embedding);
          count++;
        }
      } catch {
        // Non-fatal
      }
    }
    return count;
  }

  async search(query: string, repoId: number, limit?: number, scope?: string): Promise<SearchResult[]> {
    const effectiveLimit = limit ?? 10;

    const fts5Results = await this.searchLexical(query, repoId, effectiveLimit, scope);

    // Hybrid: run file + chunk vector search in parallel and merge with FTS5 results
    if (this.semantic?.isAvailable()) {
      try {
        // Run both file-level and chunk-level vector search
        const [vectorResults, chunkResults] = await Promise.all([
          this.semantic.vectorSearch(query, repoId, effectiveLimit, scope),
          this.semantic.vectorSearchChunks(query, repoId, effectiveLimit, scope),
        ]);

        // Merge chunk results into file-level vector results (take best score per file)
        const combinedVector = mergeVectorAndChunkResults(vectorResults, chunkResults);

        return mergeResults(
          fts5Results,
          combinedVector,
          effectiveLimit,
          this.searchConfig.semanticBlendAlpha,
          !!scope,
        );
      } catch {
        this.opts.onFallback?.("Semantic vector search failed, using FTS5 results");
      }
    }

    return fts5Results;
  }

  async searchLexical(query: string, repoId: number, limit?: number, scope?: string): Promise<SearchResult[]> {
    const backend = this.activeBackend ?? this.fts5;
    const effectiveLimit = limit ?? 10;

    try {
      return await backend.search(query, repoId, effectiveLimit, scope);
    } catch {
      if (backend !== this.fts5) {
        this.opts.onFallback?.(`${backend.name} search failed, falling back to FTS5`);
        return this.fts5.search(query, repoId, effectiveLimit, scope);
      }
      return [];
    }
  }

  async rebuildIndex(repoId: number): Promise<void> {
    this.fts5.rebuildIndex(repoId);
    this.fts5.rebuildTicketFts(repoId);
    if (this.zoekt && (await this.zoekt.isAvailable())) {
      await this.zoekt.indexRepo();
    }
  }

  getActiveBackendName(): SearchBackendName {
    const base = (this.activeBackend?.name ?? "fts5") as "fts5" | "zoekt";
    if (this.semantic?.isAvailable()) {
      return `${base}+semantic`;
    }
    return base;
  }

  getSemanticReranker(): SemanticReranker | null {
    return this.semantic;
  }

  getLexicalBackendName(): "fts5" | "zoekt" {
    return (this.activeBackend?.name ?? "fts5") as "fts5" | "zoekt";
  }

  getSearchConfig(): SearchConfigShape {
    return this.searchConfig;
  }

  // ─── Knowledge FTS5 pass-through ──────────────────────────

  /** Initialize knowledge FTS table for an arbitrary sqlite handle (repo or global). */
  initKnowledgeFts(sqlite: DatabaseType): void {
    this.fts5.initKnowledgeFts(sqlite);
  }

  isKnowledgeIndexCurrent(sqlite: DatabaseType): boolean {
    return this.fts5.isKnowledgeIndexCurrent(sqlite);
  }

  /** Rebuild knowledge FTS index for an arbitrary sqlite handle. */
  rebuildKnowledgeFts(sqlite: DatabaseType): void {
    this.fts5.rebuildKnowledgeFts(sqlite);
  }

  upsertKnowledgeFts(sqlite: DatabaseType, knowledgeId: number): void {
    this.fts5.upsertKnowledgeFts(sqlite, knowledgeId);
  }

  /** Search knowledge entries via FTS5. Works regardless of semantic model status. */
  searchKnowledge(sqlite: DatabaseType, query: string, limit?: number, type?: string): KnowledgeFtsResult[] {
    return this.fts5.searchKnowledge(sqlite, query, limit, type);
  }

  initTicketFts(): void {
    this.fts5.initTicketFts();
  }

  rebuildTicketFts(repoId: number): void {
    this.fts5.rebuildTicketFts(repoId);
  }

  searchTickets(
    query: string,
    repoId: number,
    limit?: number,
    opts?: {
      status?: string;
      severity?: string;
      assigneeAgentId?: string;
    },
  ): TicketFtsResult[] {
    return this.fts5.searchTickets(query, repoId, limit, opts);
  }
}

/**
 * Merge file-level and chunk-level vector results.
 * For each file, takes the higher score from either source.
 * Chunk results provide finer precision; file results provide broad coverage.
 */
function mergeVectorAndChunkResults(
  fileResults: SearchResult[],
  chunkResults: SearchResult[],
): SearchResult[] {
  const scoreMap = new Map<string, number>();

  for (const r of fileResults) {
    scoreMap.set(r.path, r.score);
  }

  for (const r of chunkResults) {
    const existing = scoreMap.get(r.path);
    if (existing === undefined || r.score > existing) {
      scoreMap.set(r.path, r.score);
    }
  }

  const merged: SearchResult[] = [];
  for (const [path, score] of scoreMap) {
    merged.push({ path, score });
  }

  merged.sort((a, b) => b.score - a.score);
  return merged;
}
