import type { Database as DatabaseType } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { SearchBackend, SearchBackendName, SearchResult } from "./interface.js";
import { FTS5Backend, type KnowledgeFtsResult, type TicketFtsResult } from "./fts5.js";
import { ZoektBackend } from "./zoekt.js";
import { SemanticReranker, mergeResults } from "./semantic.js";
import { DEFAULT_SEARCH_CONFIG, type SearchConfigShape } from "./constants.js";

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
    this.fts5.rebuildIndex(this.opts.repoId);
    // Initialize knowledge FTS for repo DB
    this.fts5.initKnowledgeFts(this.opts.sqlite);
    this.fts5.rebuildKnowledgeFts(this.opts.sqlite);
    this.fts5.initTicketFts();
    this.fts5.rebuildTicketFts(this.opts.repoId);

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
      }
    }
  }

  async search(query: string, repoId: number, limit?: number, scope?: string): Promise<SearchResult[]> {
    const backend = this.activeBackend ?? this.fts5;
    const effectiveLimit = limit ?? 10;

    const fts5Results = await this.searchLexical(query, repoId, effectiveLimit, scope);

    // Hybrid: run vector search in parallel and merge with FTS5 results
    if (this.semantic?.isAvailable()) {
      try {
        // Scope is now filtered at SQL level inside vectorSearch (not post-hoc)
        const vectorResults = await this.semantic.vectorSearch(query, repoId, effectiveLimit, scope);
        return mergeResults(
          fts5Results,
          vectorResults,
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

  /** Rebuild knowledge FTS index for an arbitrary sqlite handle. */
  rebuildKnowledgeFts(sqlite: DatabaseType): void {
    this.fts5.rebuildKnowledgeFts(sqlite);
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
