import type { Pool } from "mysql2/promise";
import { err, ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import { StorageError } from "../core/errors.js";

/**
 * DDL statements for all Dolt tables.
 * These statements use IF NOT EXISTS to be idempotent.
 */
export const SCHEMA_STATEMENTS = [
  // Search documents - indexed content for full-text search
  `CREATE TABLE IF NOT EXISTS search_documents (
    id VARCHAR(255) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    content LONGTEXT NOT NULL,
    type VARCHAR(50) NOT NULL,
    indexed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_type (type),
    INDEX idx_indexed_at (indexed_at)
  )`,

  // Search inverted index - term → document mapping for full-text search
  `CREATE TABLE IF NOT EXISTS search_inverted_index (
    term VARCHAR(255) NOT NULL,
    doc_id VARCHAR(255) NOT NULL,
    PRIMARY KEY (term, doc_id),
    FOREIGN KEY (doc_id) REFERENCES search_documents(id),
    INDEX idx_doc_id (doc_id)
  )`,

  // Search embeddings - persisted semantic vectors for restart-safe hybrid search
  `CREATE TABLE IF NOT EXISTS search_embeddings (
    doc_id VARCHAR(255) PRIMARY KEY,
    embedding_json LONGTEXT NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (doc_id) REFERENCES search_documents(id),
    INDEX idx_updated_at (updated_at)
  )`,

  // Orchestration events - audit trail of agent actions
  `CREATE TABLE IF NOT EXISTS orchestration_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    work_id VARCHAR(255) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    agent_id VARCHAR(255),
    details JSON NOT NULL DEFAULT '{}',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_work_id (work_id),
    INDEX idx_event_type (event_type),
    INDEX idx_agent_id (agent_id),
    INDEX idx_created_at (created_at)
  )`,

  // Environment snapshots - physical sandbox state captured alongside semantic context
  `CREATE TABLE IF NOT EXISTS environment_snapshots (
    id VARCHAR(64) PRIMARY KEY,
    agent_id VARCHAR(255) NOT NULL,
    work_id VARCHAR(255),
    cwd VARCHAR(1024) NOT NULL,
    git_ref JSON,
    files JSON NOT NULL,
    runtimes JSON NOT NULL,
    package_managers JSON NOT NULL,
    lockfiles JSON NOT NULL,
    memory JSON,
    raw LONGTEXT,
    captured_at TIMESTAMP(3) NOT NULL,
    INDEX idx_agent_id (agent_id),
    INDEX idx_work_id (work_id),
    INDEX idx_captured_at (captured_at)
  )`,

  // Convoys - named groups of work articles with a lead whose progress unblocks members (ADR-009)
  `CREATE TABLE IF NOT EXISTS convoys (
    id VARCHAR(255) PRIMARY KEY,
    lead_work_id VARCHAR(255) NOT NULL,
    member_work_ids JSON NOT NULL,
    goal TEXT NOT NULL,
    status ENUM('active','completed','cancelled') NOT NULL DEFAULT 'active',
    target_phase VARCHAR(50) NOT NULL DEFAULT 'implementation',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    INDEX idx_status (status),
    INDEX idx_lead (lead_work_id),
    INDEX idx_created_at (created_at)
  )`,

  // Code artifacts - lightweight inventory mirror (ADR-017 D1).
  // The JSON file under `.monsthera/cache/code-index.json` is the canonical
  // read surface; this Dolt mirror is write-only from M3's perspective and
  // exists so M4 (provider bridge) can issue SQL queries without rebuilding
  // the inventory.
  //
  // Column type rationale (ADR-017 §"Open questions" — Dolt schema):
  //   id          : `kind:path:name@line` composite — VARCHAR(512) is generous
  //                 enough for deeply nested paths plus identifier names
  //                 (Dolt's index limits cap effective key prefix at 767 bytes).
  //   path        : TEXT for cross-platform repo paths beyond 255 chars; the
  //                 idx_path index is keyed on a 255-byte prefix to stay
  //                 under MySQL's index-key-length limit.
  //   start/end_line: INT (line numbers fit comfortably; SMALLINT would cap
  //                 at 32k which some generated TS files exceed).
  //   exported, stale: TINYINT(1) — MySQL's idiomatic boolean.
  `CREATE TABLE IF NOT EXISTS code_artifacts (
    id VARCHAR(512) PRIMARY KEY,
    kind VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    path TEXT NOT NULL,
    language VARCHAR(64),
    start_line INT,
    end_line INT,
    exported TINYINT(1),
    scope VARCHAR(255),
    stale TINYINT(1) NOT NULL DEFAULT 0,
    INDEX idx_path (path(255)),
    INDEX idx_kind (kind),
    INDEX idx_language (language)
  )`,

  // Code relations - edges between code artifacts (ADR-017 D1).
  // M3 only emits `contains` (file → symbol) and `defines`. M4 will extend
  // with `imports` and other edge kinds; the (source_id, target_id, kind)
  // composite key supports parallel edge kinds between the same nodes.
  `CREATE TABLE IF NOT EXISTS code_relations (
    source_id VARCHAR(512) NOT NULL,
    target_id VARCHAR(512) NOT NULL,
    kind VARCHAR(64) NOT NULL,
    confidence VARCHAR(16) NOT NULL,
    PRIMARY KEY (source_id, target_id, kind),
    INDEX idx_source (source_id),
    INDEX idx_target (target_id),
    INDEX idx_kind (kind)
  )`,
] as const;

/**
 * Initialize the database schema by executing all DDL statements.
 * Idempotent - safe to call multiple times.
 */
export async function initializeSchema(pool: Pool): Promise<Result<void, StorageError>> {
  try {
    for (const statement of SCHEMA_STATEMENTS) {
      try {
        // Execute DDL statement directly; we don't need the result
        await pool.execute(statement);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return err(
          new StorageError(`Schema initialization failed: ${message}`, { statement, error: String(error) }),
        );
      }
    }
    return ok(void 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new StorageError(`Schema initialization failed: ${message}`, { error: String(error) }));
  }
}
