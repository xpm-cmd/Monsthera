import type { Database as DatabaseType } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { SearchBackend, SearchResult } from "./interface.js";
import { FTS5Backend } from "./fts5.js";
import { ZoektBackend } from "./zoekt.js";

export interface SearchRouterOptions {
  sqlite: DatabaseType;
  db: BetterSQLite3Database<typeof schema>;
  repoPath: string;
  zoektEnabled: boolean;
  indexDir: string;
  onFallback?: (reason: string) => void;
}

/**
 * Routes search queries to the best available backend.
 * Tries Zoekt first (if enabled), falls back to FTS5.
 */
export class SearchRouter {
  private fts5: FTS5Backend;
  private zoekt: ZoektBackend | null;
  private activeBackend: SearchBackend | null = null;

  constructor(private opts: SearchRouterOptions) {
    this.fts5 = new FTS5Backend(opts.sqlite, opts.db);
    this.zoekt = opts.zoektEnabled ? new ZoektBackend(opts.repoPath, opts.indexDir) : null;
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
  }

  async search(query: string, repoId: number, limit?: number): Promise<SearchResult[]> {
    const backend = this.activeBackend ?? this.fts5;

    try {
      return await backend.search(query, repoId, limit);
    } catch {
      // If primary backend fails, fall back to FTS5
      if (backend !== this.fts5) {
        this.opts.onFallback?.(`${backend.name} search failed, falling back to FTS5`);
        return this.fts5.search(query, repoId, limit);
      }
      return [];
    }
  }

  async rebuildIndex(repoId: number): Promise<void> {
    this.fts5.rebuildIndex(repoId);
    if (this.zoekt && (await this.zoekt.isAvailable())) {
      await this.zoekt.indexRepo();
    }
  }

  getActiveBackendName(): "fts5" | "zoekt" {
    return (this.activeBackend?.name ?? "fts5") as "fts5" | "zoekt";
  }
}
