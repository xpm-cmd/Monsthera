export { eq, and, like, desc, or, sql, notInArray, isNull, isNotNull, inArray } from "drizzle-orm";
export type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
export type { Database as SqliteDatabase } from "better-sqlite3";
export { parseStringArrayJson } from "../../core/input-hardening.js";
export type * as schema from "../schema.js";
export * as tables from "../schema.js";

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../schema.js";

export type DB = BetterSQLite3Database<typeof schema>;
export type QueryDb = Pick<DB, "select" | "insert" | "update" | "delete">;

export function escapeLike(s: string): string {
  return s.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function isMissingTableError(error: unknown, tableName: string): boolean {
  return error instanceof Error && error.message.includes(`no such table: ${tableName}`);
}
