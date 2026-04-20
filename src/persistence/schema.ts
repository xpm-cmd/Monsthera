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
