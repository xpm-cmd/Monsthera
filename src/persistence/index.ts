/**
 * Public API for the persistence module.
 * Exports connection management, schema initialization, and health monitoring.
 */

// Connection management
export {
  createDoltPool,
  closePool,
  executeQuery,
  executeMutation,
  getConnection,
  executeTransaction,
} from "./connection.js";
export type { DoltConnectionConfig } from "./connection.js";

// Schema management
export { initializeSchema, SCHEMA_STATEMENTS } from "./schema.js";

// Health monitoring
export { checkDoltHealth, monitorDoltHealth } from "./health.js";
export type { DoltHealthStatus } from "./health.js";

// Repository implementations (only actively used repos are exported)
export { DoltSearchIndexRepository } from "./dolt-search-repository.js";
export { DoltOrchestrationRepository } from "./dolt-orchestration-repository.js";
