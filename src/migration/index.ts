export type {
  V2Ticket,
  V2Verdict,
  V2CouncilAssignment,
  V2KnowledgeRecord,
  V2NoteRecord,
  V2SourceReader,
  MigrationMode,
  MigrationScope,
  MappedArticle,
  MappedKnowledgeArticle,
  MigrationItemResult,
  MigrationReport,
} from "./types.js";

export { mapTicketToArticle, computeMigrationHash } from "./mapper.js";
export { AliasStore } from "./alias-store.js";
export { MigrationService } from "./service.js";
export type { MigrationServiceDeps } from "./service.js";
export { migrationToolDefinitions, handleMigrationTool } from "./tools.js";
export { SqliteV2SourceReader } from "./v2-reader.js";
