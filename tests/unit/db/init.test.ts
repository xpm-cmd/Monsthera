import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
});
