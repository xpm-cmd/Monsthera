import type { Database as DatabaseType } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import type * as schema from "../db/schema.js";
import * as tables from "../db/schema.js";
import type { SearchBackend, SearchResult } from "./interface.js";

const FTS_TABLE = "files_fts";

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

  async search(query: string, repoId: number, limit = 20): Promise<SearchResult[]> {
    const sanitized = sanitizeFts5Query(query);
    if (!sanitized) return [];

    try {
      const stmt = this.sqlite.prepare(`
        SELECT file_id, path, rank
        FROM ${FTS_TABLE}
        WHERE ${FTS_TABLE} MATCH ? AND repo_id = ?
        ORDER BY rank
        LIMIT ?
      `);

      const rows = stmt.all(sanitized, repoId, limit) as Array<{
        file_id: number;
        path: string;
        rank: number;
      }>;

      return rows.map((row) => ({
        path: row.path,
        score: Math.abs(row.rank),
      }));
    } catch {
      return this.fallbackSearch(query, repoId, limit);
    }
  }

  private fallbackSearch(query: string, repoId: number, limit: number): SearchResult[] {
    const files = this.db
      .select()
      .from(tables.files)
      .where(eq(tables.files.repoId, repoId))
      .all();

    return files
      .filter((f) => {
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
  return terms.join(" OR ");
}
