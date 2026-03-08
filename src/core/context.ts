import type { Database as DatabaseType } from "better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { AgoraConfig } from "./config.js";
import type { SearchRouter } from "../search/router.js";
import type { InsightStream } from "./insight-stream.js";
import type { CoordinationBus } from "../coordination/bus.js";

/**
 * Shared runtime context available to all MCP tool handlers.
 * Initialized once at server startup.
 */
export interface AgoraContext {
  config: AgoraConfig;
  db: BetterSQLite3Database<typeof schema>;
  sqlite: DatabaseType;
  repoId: number;
  repoPath: string;
  searchRouter: SearchRouter;
  insight: InsightStream;
  bus: CoordinationBus;
  globalDb: BetterSQLite3Database<typeof schema> | null;
  globalSqlite: DatabaseType | null;
}
