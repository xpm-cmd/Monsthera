import type { Database as DatabaseType } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import type * as schema from "../db/schema.js";
import { TagsSchema } from "../core/input-hardening.js";
import * as tables from "../db/schema.js";
import type { SearchBackend, SearchResult } from "./interface.js";
import {
  DEFAULT_AND_QUERY_TERM_THRESHOLD,
  DEFAULT_CONFIG_FILE_PENALTY_FACTOR,
  DEFAULT_SEARCH_CONFIG,
  DEFAULT_TEST_FILE_PENALTY_FACTOR,
  type SearchConfigShape,
} from "./constants.js";

const FTS_TABLE = "files_fts";
const KNOWLEDGE_FTS_TABLE = "knowledge_fts";
const TICKETS_FTS_TABLE = "tickets_fts";
const RawFileSymbolsSchema = z.array(z.object({ name: z.string().min(1) }));
export const TEST_FILE_PENALTY_FACTOR = DEFAULT_TEST_FILE_PENALTY_FACTOR;
export const CONFIG_FILE_PENALTY_FACTOR = DEFAULT_CONFIG_FILE_PENALTY_FACTOR;
const TEST_RELATED_QUERY_PATTERN = /\b(test(?:ing|s)?|unit|integration|e2e|spec(?:s)?)\b/i;

export interface KnowledgeFtsResult {
  knowledgeId: number;
  title: string;
  score: number;
}

export interface TicketFtsResult {
  ticketInternalId: number;
  ticketId: string;
  title: string;
  status: string;
  severity: string;
  assigneeAgentId: string | null;
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
    private onWarning: (message: string) => void = () => undefined,
    private searchConfig: SearchConfigShape = DEFAULT_SEARCH_CONFIG,
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
    this.sqlite.prepare(`DELETE FROM ${FTS_TABLE} WHERE repo_id = ?`).run(repoId);

    const files = this.db.select().from(tables.files).where(eq(tables.files.repoId, repoId)).all();

    const insert = this.sqlite.prepare(
      `INSERT INTO ${FTS_TABLE}(file_id, repo_id, path, summary, symbols, language) VALUES (?, ?, ?, ?, ?, ?)`,
    );

    const batch = this.sqlite.transaction(() => {
      for (const file of files) {
        const symbols = parseJsonWithWarning(
          file.symbolsJson,
          RawFileSymbolsSchema,
          [],
          (reason) => this.onWarning(`FTS5 file symbol parse failed for ${file.path}: ${reason}`),
        );
        const symbolNames = symbols
          .map((symbol) => symbol.name.trim().slice(0, 200))
          .filter(Boolean)
          .map((name) => expandCamelCase(name))
          .join(" ");

        insert.run(file.id, file.repoId, file.path, file.summary ?? "", symbolNames, file.language ?? "");
      }
    });
    batch();
  }

  isFileIndexCurrent(repoId: number): boolean {
    const indexedRows = this.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${FTS_TABLE} WHERE repo_id = ?`)
      .get(repoId) as { count: number } | undefined;
    const sourceRows = this.sqlite.prepare("SELECT COUNT(*) AS count FROM files WHERE repo_id = ?")
      .get(repoId) as { count: number } | undefined;
    return (indexedRows?.count ?? 0) === (sourceRows?.count ?? 0);
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
   * Refresh a single knowledge entry in the FTS index.
   * Falls back to delete-only behavior when the source row is no longer active.
   */
  upsertKnowledgeFts(sqlite: DatabaseType, knowledgeId: number): void {
    sqlite.prepare(`DELETE FROM ${KNOWLEDGE_FTS_TABLE} WHERE knowledge_id = ?`).run(knowledgeId);

    const row = sqlite
      .prepare("SELECT id, title, content, type, tags_json FROM knowledge WHERE id = ? AND status = 'active'")
      .get(knowledgeId) as { id: number; title: string; content: string; type: string; tags_json: string | null } | undefined;
    if (!row) return;

    sqlite.prepare(
      `INSERT INTO ${KNOWLEDGE_FTS_TABLE}(knowledge_id, title, content, type, tags) VALUES (?, ?, ?, ?, ?)`,
    ).run(row.id, row.title, row.content, row.type, row.tags_json ?? "");
  }

  isKnowledgeIndexCurrent(sqlite: DatabaseType): boolean {
    const indexedRows = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${KNOWLEDGE_FTS_TABLE}`)
      .get() as { count: number } | undefined;
    const sourceRows = sqlite.prepare("SELECT COUNT(*) AS count FROM knowledge WHERE status = 'active'")
      .get() as { count: number } | undefined;
    return (indexedRows?.count ?? 0) === (sourceRows?.count ?? 0);
  }

  // ─── Ticket FTS5 ───────────────────────────────────────────

  initTicketFts(): void {
    this.sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${TICKETS_FTS_TABLE} USING fts5(
        ticket_internal_id UNINDEXED,
        repo_id UNINDEXED,
        ticket_id,
        title,
        description,
        tags,
        status UNINDEXED,
        severity UNINDEXED,
        assignee_agent_id UNINDEXED
      );
    `);
  }

  rebuildTicketFts(repoId: number): void {
    this.sqlite.prepare(`DELETE FROM ${TICKETS_FTS_TABLE} WHERE repo_id = ?`).run(repoId);

    const tickets = this.db
      .select()
      .from(tables.tickets)
      .where(eq(tables.tickets.repoId, repoId))
      .all();

    const insert = this.sqlite.prepare(`
      INSERT INTO ${TICKETS_FTS_TABLE}(
        ticket_internal_id,
        repo_id,
        ticket_id,
        title,
        description,
        tags,
        status,
        severity,
        assignee_agent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const batch = this.sqlite.transaction(() => {
      for (const ticket of tickets) {
        const tags = parseJsonWithWarning(
          ticket.tagsJson,
          TagsSchema,
          [],
          (reason) => this.onWarning(`FTS5 ticket tag parse failed for ${ticket.ticketId}: ${reason}`),
        ).join(" ");

        insert.run(
          ticket.id,
          ticket.repoId,
          ticket.ticketId,
          ticket.title,
          ticket.description,
          tags,
          ticket.status,
          ticket.severity,
          ticket.assigneeAgentId ?? null,
        );
      }
    });

    batch();
  }

  isTicketIndexCurrent(repoId: number): boolean {
    const indexedRows = this.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${TICKETS_FTS_TABLE} WHERE repo_id = ?`)
      .get(repoId) as { count: number } | undefined;
    const sourceRows = this.sqlite.prepare("SELECT COUNT(*) AS count FROM tickets WHERE repo_id = ?")
      .get(repoId) as { count: number } | undefined;
    return (indexedRows?.count ?? 0) === (sourceRows?.count ?? 0);
  }

  searchTickets(
    query: string,
    repoId: number,
    limit = 10,
    opts?: {
      status?: string;
      severity?: string;
      assigneeAgentId?: string;
    },
  ): TicketFtsResult[] {
    const sanitized = sanitizeFts5Query(query, this.searchConfig.thresholds.andQueryTermCount);
    if (!sanitized) return [];

    try {
      let sql = `
        SELECT
          ticket_internal_id,
          ticket_id,
          title,
          status,
          severity,
          assignee_agent_id,
          bm25(
            ${TICKETS_FTS_TABLE},
            ${this.searchConfig.bm25.ticket.ticketId},
            ${this.searchConfig.bm25.ticket.title},
            ${this.searchConfig.bm25.ticket.description},
            ${this.searchConfig.bm25.ticket.tags}
          ) AS rank
        FROM ${TICKETS_FTS_TABLE}
        WHERE ${TICKETS_FTS_TABLE} MATCH ? AND repo_id = ?`;
      const params: unknown[] = [sanitized, repoId];

      if (opts?.status) {
        sql += " AND status = ?";
        params.push(opts.status);
      }
      if (opts?.severity) {
        sql += " AND severity = ?";
        params.push(opts.severity);
      }
      if (opts?.assigneeAgentId) {
        sql += " AND assignee_agent_id = ?";
        params.push(opts.assigneeAgentId);
      }

      sql += " ORDER BY rank LIMIT ?";
      params.push(limit);

      const rows = this.sqlite.prepare(sql).all(...params) as Array<{
        ticket_internal_id: number;
        ticket_id: string;
        title: string;
        status: string;
        severity: string;
        assignee_agent_id: string | null;
        rank: number;
      }>;

      return rows.map((row) => ({
        ticketInternalId: row.ticket_internal_id,
        ticketId: row.ticket_id,
        title: row.title,
        status: row.status,
        severity: row.severity,
        assigneeAgentId: row.assignee_agent_id,
        score: Math.abs(row.rank),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Search knowledge entries via FTS5.
   * BM25 weights: title=3.0, content=1.0 (title matches rank higher).
   * Works regardless of semantic model status.
   */
  searchKnowledge(sqlite: DatabaseType, query: string, limit = 10, type?: string): KnowledgeFtsResult[] {
    const sanitized = sanitizeFts5Query(query, this.searchConfig.thresholds.andQueryTermCount);
    if (!sanitized) return [];

    try {
      let sql = `
        SELECT
          knowledge_id,
          title,
          bm25(
            ${KNOWLEDGE_FTS_TABLE},
            ${this.searchConfig.bm25.knowledge.title},
            ${this.searchConfig.bm25.knowledge.content}
          ) AS rank
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
    const sanitized = sanitizeFts5Query(query, this.searchConfig.thresholds.andQueryTermCount);
    if (!sanitized) return [];

    try {
      // bm25() column weights: path=1.5, summary=1.0, symbols=2.0
      // Path is boosted slightly (filenames are relevant) but not dominant
      // UNINDEXED columns (file_id, repo_id, language) are skipped automatically
      let sql = `
        SELECT
          file_id,
          path,
          bm25(
            ${FTS_TABLE},
            ${this.searchConfig.bm25.file.path},
            ${this.searchConfig.bm25.file.summary},
            ${this.searchConfig.bm25.file.symbols}
          ) AS rank
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

      const queryMentionsTest = isTestRelatedQuery(query);

      return rows.map((row) => {
        let score = Math.abs(row.rank);
        // Penalize test files when query doesn't mention testing
        if (!queryMentionsTest && isTestFile(row.path)) {
          score *= this.searchConfig.penalties.testFiles;
        }
        // Penalize config/build files (rarely the target of code searches)
        if (isConfigFile(row.path)) {
          score *= this.searchConfig.penalties.configFiles;
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

// Common English stop words that inflate FTS5 results without adding relevance signal.
// This list is intentionally conservative — only function words with near-zero search
// value are included.  Domain keywords like "is" (which could appear in identifiers)
// are kept because they rarely dominate BM25 scoring in code repos.
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
  "this", "that", "not", "no", "if", "so", "do", "my", "we", "up",
]);

export function sanitizeFts5Query(
  query: string,
  andQueryTermCount = DEFAULT_AND_QUERY_TERM_THRESHOLD,
): string {
  const trimmed = query.trim();
  if (!trimmed) return "";

  // Phase 1: Extract user-typed phrase queries ("exact phrase" → FTS5 phrase)
  const phrases: string[] = [];
  const remaining = trimmed.replace(/"([^"]+)"/g, (_match, phrase: string) => {
    const escaped = phrase.replace(/"/g, '""');
    phrases.push(`"${escaped}"`);
    return " ";
  });

  // Phase 2: Tokenize remaining text
  // Split on whitespace AND colons to tokenize key prefixes like "map:fe-hooks-stores"
  const terms = remaining
    .split(/[\s:]+/)
    .filter(Boolean)
    .map((term) => {
      // Escape double-quotes for FTS5 (inside quotes, " → "")
      const escaped = term.replace(/"/g, '""');
      // Strip only trailing * (FTS5 prefix operator) — keep all other chars
      // since they are literal inside FTS5 quoted strings
      const clean = escaped.replace(/\*$/, "");
      if (!isAllowedQueryToken(clean)) return "";
      const variants = expandQueryTerm(clean);
      if (variants.length === 1) {
        return `"${variants[0]}"`;
      }
      return `(${variants.map((variant) => `"${variant}"`).join(" OR ")})`;
    })
    .filter(Boolean);

  const allTerms = [...phrases, ...terms];
  if (allTerms.length === 0) return "";

  // 1-3 terms: AND for precision — focused queries need all tokens present.
  // 4+ terms: OR — BM25 ranks multi-match documents higher naturally.
  if (allTerms.length <= andQueryTermCount) {
    return allTerms.join(" AND ");
  }
  return allTerms.join(" OR ");
}

const TEST_PATH_PATTERN = /\/(tests?|__tests__|spec|__spec__)\//i;
const TEST_FILE_PATTERN = /\.(test|spec)\.[^.]+$/i;

export function isTestFile(path: string): boolean {
  return TEST_PATH_PATTERN.test(path) || TEST_FILE_PATTERN.test(path);
}

export function isTestRelatedQuery(query: string): boolean {
  return TEST_RELATED_QUERY_PATTERN.test(query);
}

const CONFIG_FILE_PATTERN = /(?:^|\/)(Dockerfile(?:\.[^/]+)?|Makefile|\.github\/workflows\/[^/]+\.ya?ml|tsconfig[^/]*|\.eslintrc[^/]*|vite\.config[^/]*|webpack[^/]*|jest\.config[^/]*|package\.json|\.prettierrc[^/]*|\.babelrc[^/]*|rollup\.config[^/]*)$/i;

export function isConfigFile(path: string): boolean {
  return CONFIG_FILE_PATTERN.test(path);
}

function parseJsonWithWarning<T>(
  raw: string | null | undefined,
  schema: z.ZodType<T>,
  fallback: T,
  onWarning: (reason: string) => void,
): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    onWarning(result.error.issues.map((issue) => issue.message).join("; "));
    return fallback;
  } catch (error) {
    onWarning(error instanceof Error ? error.message : String(error));
    return fallback;
  }
}

/**
 * Expand CamelCase/PascalCase identifiers into constituent words for FTS5.
 * "OptimizationNode" → "OptimizationNode Optimization Node"
 * "useCreateCampaign" → "useCreateCampaign use Create Campaign"
 * Keeps the original name intact so exact matches still work.
 */
function expandCamelCase(name: string): string {
  const parts = splitCamelCase(name);
  if (parts.length <= 1) return name;
  return `${name} ${parts.join(" ")}`;
}

function expandQueryTerm(term: string): string[] {
  const variants = [term, ...splitCamelCase(term).filter(isAllowedQueryToken)];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const variant of variants) {
    const normalized = variant.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(variant);
  }
  return deduped;
}

function splitCamelCase(value: string): string[] {
  // Split on camelCase boundaries: lowercase→uppercase, or between consecutive uppercase and lowercase
  return value.split(/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).filter(Boolean);
}

function isAllowedQueryToken(term: string): boolean {
  if (!term) return false;
  if (term.length < 2 && !/^[A-Z_]$/.test(term)) return false;
  return !STOP_WORDS.has(term.toLowerCase());
}
