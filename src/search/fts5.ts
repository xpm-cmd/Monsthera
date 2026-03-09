import type { Database as DatabaseType } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import type * as schema from "../db/schema.js";
import * as tables from "../db/schema.js";
import type { SearchBackend, SearchResult } from "./interface.js";

const FTS_TABLE = "files_fts";
const KNOWLEDGE_FTS_TABLE = "knowledge_fts";

export interface KnowledgeFtsResult {
  knowledgeId: number;
  title: string;
  score: number;
}

/**
 * FTS5 search backend — always available since it uses SQLite's built-in FTS5 extension.
 * Indexes file paths, summaries, and symbol names for full-text search.
 */
export class FTS5Backend implements SearchBackend {
  readonly name = "fts5" as const;

  constructor(
    private sqlite: DatabaseType,
    private db: BetterSQLite3Database<typeof schema>,
  ) {}

  async isAvailable(): Promise<boolean> {
    return true; // FTS5 is always available in modern SQLite
  }

  /**
   * Initialize the FTS5 virtual table. Call after database creation and after each reindex.
   */
  initFtsTable(): void {
    this.sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
        file_id UNINDEXED,
        repo_id UNINDEXED,
        path,
        summary,
        symbols,
        language UNINDEXED
      );
    `);
  }

  /**
   * Rebuild the FTS index from the files table.
   */
  rebuildIndex(repoId: number): void {
    this.sqlite.exec(`DELETE FROM ${FTS_TABLE} WHERE repo_id = ${repoId}`);

    const files = this.db.select().from(tables.files).where(eq(tables.files.repoId, repoId)).all();

    const insert = this.sqlite.prepare(
      `INSERT INTO ${FTS_TABLE}(file_id, repo_id, path, summary, symbols, language) VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const batch = this.sqlite.transaction(() => {
      for (const file of files) {
        let symbolNames = "";
        try {
          const symbols = JSON.parse(file.symbolsJson ?? "[]") as Array<{ name: string }>;
          symbolNames = symbols.map((s) => s.name).join(" ");
        } catch {
          // ignore parse errors
        }

        insert.run(file.id, file.repoId, file.path, file.summary ?? "", symbolNames, file.language ?? "");
      }
    });
    batch();
  }

  // ─── Knowledge FTS5 ───────────────────────────────────────

  /**
   * Create the knowledge FTS5 virtual table (idempotent).
   * Operates on a given sqlite handle to support both repo and global DBs.
   */
  initKnowledgeFts(sqlite: DatabaseType): void {
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${KNOWLEDGE_FTS_TABLE} USING fts5(
        knowledge_id UNINDEXED,
        title,
        content,
        type UNINDEXED,
        tags
      );
    `);
  }

  /**
   * Rebuild the knowledge FTS index from the knowledge table.
   * Fast for <500 entries — called on store/archive/delete.
   */
  rebuildKnowledgeFts(sqlite: DatabaseType): void {
    sqlite.exec(`DELETE FROM ${KNOWLEDGE_FTS_TABLE}`);
    const rows = sqlite
      .prepare("SELECT id, title, content, type, tags_json FROM knowledge WHERE status = 'active'")
      .all() as Array<{ id: number; title: string; content: string; type: string; tags_json: string | null }>;

    const insert = sqlite.prepare(
      `INSERT INTO ${KNOWLEDGE_FTS_TABLE}(knowledge_id, title, content, type, tags) VALUES (?, ?, ?, ?, ?)`,
    );

    const batch = sqlite.transaction(() => {
      for (const row of rows) {
        insert.run(row.id, row.title, row.content, row.type, row.tags_json ?? "");
      }
    });
    batch();
  }

  /**
   * Search knowledge entries via FTS5.
   * BM25 weights: title=3.0, content=1.0 (title matches rank higher).
   * Works regardless of semantic model status.
   */
  searchKnowledge(sqlite: DatabaseType, query: string, limit = 10, type?: string): KnowledgeFtsResult[] {
    const sanitized = sanitizeFts5Query(query);
    if (!sanitized) return [];

    try {
      let sql = `
        SELECT knowledge_id, title, bm25(${KNOWLEDGE_FTS_TABLE}, 3.0, 1.0) AS rank
        FROM ${KNOWLEDGE_FTS_TABLE}
        WHERE ${KNOWLEDGE_FTS_TABLE} MATCH ?`;
      const params: unknown[] = [sanitized];

      if (type) {
        sql += ` AND type = ?`;
        params.push(type);
      }

      sql += ` ORDER BY rank LIMIT ?`;
      params.push(limit);

      const rows = sqlite.prepare(sql).all(...params) as Array<{
        knowledge_id: number;
        title: string;
        rank: number;
      }>;

      return rows.map((row) => ({
        knowledgeId: row.knowledge_id,
        title: row.title,
        score: Math.abs(row.rank),
      }));
    } catch {
      return []; // FTS5 query failed (bad syntax), return empty
    }
  }

  // ─── File search ─────────────────────────────────────────

  async search(query: string, repoId: number, limit = 20, scope?: string): Promise<SearchResult[]> {
    const sanitized = sanitizeFts5Query(query);
    if (!sanitized) return [];

    try {
      // bm25() column weights: path=1.5, summary=1.0, symbols=2.0
      // Path is boosted slightly (filenames are relevant) but not dominant
      // UNINDEXED columns (file_id, repo_id, language) are skipped automatically
      let sql = `
        SELECT file_id, path, bm25(${FTS_TABLE}, 1.5, 1.0, 2.0) AS rank
        FROM ${FTS_TABLE}
        WHERE ${FTS_TABLE} MATCH ? AND repo_id = ?`;
      const params: unknown[] = [sanitized, repoId];

      if (scope) {
        sql += ` AND path LIKE ?`;
        params.push(scope.replace(/%/g, "\\%") + "%");
      }

      sql += `
        ORDER BY rank
        LIMIT ?`;
      params.push(limit * 2);

      const stmt = this.sqlite.prepare(sql);

      // Fetch extra candidates to compensate for test file penalty
      const rows = stmt.all(...params) as Array<{
        file_id: number;
        path: string;
        rank: number;
      }>;

      const queryLower = query.toLowerCase();
      const queryMentionsTest = queryLower.includes("test") || queryLower.includes("spec");

      return rows.map((row) => {
        let score = Math.abs(row.rank);
        // Penalize test files when query doesn't mention testing
        if (!queryMentionsTest && isTestFile(row.path)) {
          score *= 0.7;
        }
        // Penalize config/build files (rarely the target of code searches)
        if (isConfigFile(row.path)) {
          score *= 0.5;
        }
        return { path: row.path, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    } catch {
      return this.fallbackSearch(query, repoId, limit, scope);
    }
  }

  private fallbackSearch(query: string, repoId: number, limit: number, scope?: string): SearchResult[] {
    const files = this.db
      .select()
      .from(tables.files)
      .where(eq(tables.files.repoId, repoId))
      .all();

    return files
      .filter((f) => {
        if (scope && !f.path.startsWith(scope)) return false;
        const q = query.toLowerCase();
        return (
          f.path.toLowerCase().includes(q) ||
          f.summary?.toLowerCase().includes(q) ||
          f.symbolsJson?.toLowerCase().includes(q)
        );
      })
      .slice(0, limit)
      .map((f, i) => ({ path: f.path, score: 1 / (i + 1) }));
  }
}

function sanitizeFts5Query(query: string): string {
  const terms = query
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => {
      const clean = term.replace(/[*"(){}[\]^~:]/g, "");
      return clean ? `"${clean}"` : "";
    })
    .filter(Boolean);

  if (terms.length === 0) return "";
  // AND semantics: all terms must appear (in any combination of path/summary/symbols)
  // This prevents single common words like "node" from polluting results
  return terms.join(" AND ");
}

const TEST_PATH_PATTERN = /\/(tests?|__tests__|spec|__spec__)\//i;
const TEST_FILE_PATTERN = /\.(test|spec)\.[^.]+$/i;

function isTestFile(path: string): boolean {
  return TEST_PATH_PATTERN.test(path) || TEST_FILE_PATTERN.test(path);
}

const CONFIG_FILE_PATTERN = /\/(tsconfig[^/]*|\.eslintrc[^/]*|vite\.config[^/]*|webpack[^/]*|jest\.config[^/]*|package\.json|\.prettierrc[^/]*|\.babelrc[^/]*|rollup\.config[^/]*)$/i;

function isConfigFile(path: string): boolean {
  return CONFIG_FILE_PATTERN.test(path);
}
