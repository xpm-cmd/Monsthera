import Database, { type Database as DatabaseType } from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export function createDatabase(monstheraDir: string, dbName: string): {
  db: BetterSQLite3Database<typeof schema>;
  sqlite: DatabaseType;
} {
  mkdirSync(monstheraDir, { recursive: true });
  const dbPath = join(monstheraDir, dbName);
  const sqlite = new Database(dbPath);

  // Performance and safety pragmas
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  const db = drizzle(sqlite, { schema });

  return { db, sqlite };
}
