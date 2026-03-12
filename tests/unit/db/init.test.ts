import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDatabase } from "../../../src/db/init.js";

describe("initDatabase", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("creates database and tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "agora-db-"));
    dirs.push(dir);

    const { db, sqlite } = initDatabase({
      repoPath: dir,
      agoraDir: ".agora",
      dbName: "test.db",
    });

    // Verify tables exist
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("repos");
    expect(tableNames).toContain("files");
    expect(tableNames).toContain("agents");
    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("event_logs");
    expect(tableNames).toContain("patches");
    expect(tableNames).toContain("notes");
    expect(tableNames).toContain("council_assignments");

    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((index) => index.name);
    expect(indexNames).toContain("idx_review_verdicts_ticket_specialization");
    expect(indexNames).toContain("idx_council_assignments_ticket_specialization");

    const agentColumns = sqlite
      .prepare("PRAGMA table_info(agents)")
      .all() as Array<{ name: string }>;
    const agentColumnNames = agentColumns.map((column) => column.name);
    expect(agentColumnNames).toEqual(expect.arrayContaining([
      "provider",
      "model",
      "model_family",
      "model_version",
      "identity_source",
    ]));

    sqlite.close();
  });

  it("is idempotent (can be called twice)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agora-db2-"));
    dirs.push(dir);

    const r1 = initDatabase({ repoPath: dir, agoraDir: ".agora", dbName: "test.db" });
    r1.sqlite.close();

    const r2 = initDatabase({ repoPath: dir, agoraDir: ".agora", dbName: "test.db" });
    r2.sqlite.close();
  });

  it("migrates legacy agents tables with identity columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "agora-db3-"));
    dirs.push(dir);
    const agoraDir = join(dir, ".agora");
    const sqlitePath = join(agoraDir, "test.db");
    rmSync(agoraDir, { recursive: true, force: true });
    mkdirSync(agoraDir, { recursive: true });

    const sqlite = new Database(sqlitePath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.prepare(`
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'unknown',
        role_id TEXT NOT NULL DEFAULT 'observer',
        trust_tier TEXT NOT NULL DEFAULT 'B',
        registered_at TEXT NOT NULL
      )
    `).run();
    sqlite.close();

    const result = initDatabase({ repoPath: dir, agoraDir: ".agora", dbName: "test.db" });
    const columns = result.sqlite.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);

    expect(names).toEqual(expect.arrayContaining([
      "provider",
      "model",
      "model_family",
      "model_version",
      "identity_source",
    ]));

    result.sqlite.close();
  });
});
