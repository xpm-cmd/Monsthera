import type { Database as DatabaseType } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { SearchBackend, SearchBackendName, SearchResult } from "./interface.js";
import { FTS5Backend } from "./fts5.js";
import { ZoektBackend } from "./zoekt.js";
import { SemanticReranker, mergeResults } from "./semantic.js";

export interface SearchRouterOptions {
  sqlite: DatabaseType;
  db: BetterSQLite3Database<typeof schema>;
  repoPath: string;
  zoektEnabled: boolean;
  semanticEnabled: boolean;
  indexDir: string;
  onFallback?: (reason: string) => void;
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

  constructor(private opts: SearchRouterOptions) {
    this.fts5 = new FTS5Backend(opts.sqlite, opts.db);
    this.zoekt = opts.zoektEnabled ? new ZoektBackend(opts.repoPath, opts.indexDir) : null;
    this.semantic = opts.semanticEnabled
      ? new SemanticReranker({ sqlite: opts.sqlite, db: opts.db, onFallback: opts.onFallback })
      : null;
  }

  async initialize(): Promise<void> {
    this.fts5.initFtsTable();

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

  async search(query: string, repoId: number, limit?: number): Promise<SearchResult[]> {
    const backend = this.activeBackend ?? this.fts5;
    const effectiveLimit = limit ?? 10;

    // FTS5/Zoekt keyword search
    let fts5Results: SearchResult[];
    try {
      fts5Results = await backend.search(query, repoId, effectiveLimit);
    } catch {
      if (backend !== this.fts5) {
        this.opts.onFallback?.(`${backend.name} search failed, falling back to FTS5`);
        fts5Results = await this.fts5.search(query, repoId, effectiveLimit);
      } else {
        return [];
      }
    }

    // Hybrid: run vector search in parallel and merge with FTS5 results
    if (this.semantic?.isAvailable()) {
      try {
        const vectorResults = await this.semantic.vectorSearch(query, repoId, effectiveLimit);
        return mergeResults(fts5Results, vectorResults, effectiveLimit);
      } catch {
        this.opts.onFallback?.("Semantic vector search failed, using FTS5 results");
      }
    }

    return fts5Results;
  }

  async rebuildIndex(repoId: number): Promise<void> {
    this.fts5.rebuildIndex(repoId);
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
}
