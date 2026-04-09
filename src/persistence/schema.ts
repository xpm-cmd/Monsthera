import type { Pool } from "mysql2/promise";
import { err, ok } from "../core/result.js";
import type { Result } from "../core/result.js";
import { StorageError } from "../core/errors.js";

/**
 * DDL statements for all Dolt tables.
 * These statements use IF NOT EXISTS to be idempotent.
 */
export const SCHEMA_STATEMENTS = [
  // Knowledge articles - immutable reference material
  `CREATE TABLE IF NOT EXISTS knowledge_articles (
    id VARCHAR(255) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    category VARCHAR(100) NOT NULL,
    content LONGTEXT NOT NULL,
    tags JSON NOT NULL DEFAULT '[]',
    code_refs JSON NOT NULL DEFAULT '[]',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_slug (slug),
    INDEX idx_category (category),
    INDEX idx_created_at (created_at)
  )`,

  // Work articles - project tasks with lifecycle
  `CREATE TABLE IF NOT EXISTS work_articles (
    id VARCHAR(255) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    template VARCHAR(50) NOT NULL,
    phase VARCHAR(50) NOT NULL,
    priority VARCHAR(50) NOT NULL,
    author VARCHAR(255),
    \`lead\` VARCHAR(255),
    assignee VARCHAR(255),
    content LONGTEXT NOT NULL,
    tags JSON NOT NULL DEFAULT '[]',
    \`references\` JSON NOT NULL DEFAULT '[]',
    code_refs JSON NOT NULL DEFAULT '[]',
    dependencies JSON NOT NULL DEFAULT '[]',
    blocked_by JSON NOT NULL DEFAULT '[]',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    INDEX idx_phase (phase),
    INDEX idx_priority (priority),
    INDEX idx_author (author),
    INDEX idx_assignee (assignee),
    INDEX idx_created_at (created_at)
  )`,

  // Enrichment assignments - tracks which agents contributed to which work items
  `CREATE TABLE IF NOT EXISTS enrichment_assignments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    work_id VARCHAR(255) NOT NULL,
    role VARCHAR(100) NOT NULL,
    agent_id VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL,
    contributed_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (work_id) REFERENCES work_articles(id),
    INDEX idx_work_id (work_id),
    INDEX idx_agent_id (agent_id),
    INDEX idx_status (status),
    INDEX idx_role (role)
  )`,

  // Review assignments - tracks reviews on work items
  `CREATE TABLE IF NOT EXISTS review_assignments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    work_id VARCHAR(255) NOT NULL,
    agent_id VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL,
    reviewed_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (work_id) REFERENCES work_articles(id),
    INDEX idx_work_id (work_id),
    INDEX idx_agent_id (agent_id),
    INDEX idx_status (status)
  )`,

  // Phase history - audit trail of phase transitions
  `CREATE TABLE IF NOT EXISTS phase_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    work_id VARCHAR(255) NOT NULL,
    phase VARCHAR(50) NOT NULL,
    entered_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    exited_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (work_id) REFERENCES work_articles(id),
    INDEX idx_work_id (work_id),
    INDEX idx_phase (phase),
    INDEX idx_entered_at (entered_at)
  )`,

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
