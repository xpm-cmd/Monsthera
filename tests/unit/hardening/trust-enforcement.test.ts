import { describe, it, expect } from "vitest";
import { checkToolAccess, canReadNoteType, canWriteNoteType, getMaxCodeSpanLines } from "../../../src/trust/tiers.js";
import { buildEvidenceBundle } from "../../../src/retrieval/evidence-bundle.js";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";

describe("Class 6: Trust + Role Enforcement", () => {
  // Tier B agent queries → no raw code in response
  it("Tier B bundles never include code spans", async () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.prepare(`CREATE TABLE files (id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL, path TEXT NOT NULL, language TEXT, content_hash TEXT, summary TEXT, symbols_json TEXT, has_secrets INTEGER DEFAULT 0, secret_line_ranges TEXT, indexed_at TEXT, commit_sha TEXT)`).run();
    sqlite.prepare(`CREATE TABLE repos (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
    sqlite.prepare(`INSERT INTO repos (path, name, created_at) VALUES (?, ?, ?)`).run("/test", "test", new Date().toISOString());
    sqlite.prepare(`INSERT INTO files (repo_id, path, language, summary, symbols_json) VALUES (?, ?, ?, ?, ?)`).run(
      1, "src/app.ts", "typescript", "Main app", "[]",
    );
    const db = drizzle(sqlite, { schema });

    const bundle = await buildEvidenceBundle({
      query: "app",
      repoId: 1,
      repoPath: "/test",
      commit: "abc123",
      trustTier: "B",
      searchBackend: "fts5",
      searchResults: [{ path: "src/app.ts", score: 1.0 }],
      db,
      expand: true,
    });

    expect(bundle.trustTier).toBe("B");
    expect(bundle.redactionPolicy).toBe("code_stripped");
    expect(bundle.expanded).toHaveLength(0); // No expansions for Tier B
    sqlite.close();
  });

  it("Tier A bundles can include code spans", async () => {
    expect(getMaxCodeSpanLines("A")).toBe(200);
    expect(getMaxCodeSpanLines("B")).toBe(0);
  });

  // Observer role proposes patch → denied
  it("observer role cannot propose patches", () => {
    const access = checkToolAccess("propose_patch", "observer", "B");
    expect(access.allowed).toBe(false);
    expect(access.reason).toContain("does not have access");
  });

  it("observer role cannot propose notes", () => {
    const access = checkToolAccess("propose_note", "observer", "B");
    expect(access.allowed).toBe(false);
  });

  it("developer role can propose patches", () => {
    const access = checkToolAccess("propose_patch", "developer", "A");
    expect(access.allowed).toBe(true);
  });

  it("reviewer role cannot propose patches", () => {
    const access = checkToolAccess("propose_patch", "reviewer", "A");
    expect(access.allowed).toBe(false);
  });

  it("reviewer can propose notes but not all types", () => {
    const access = checkToolAccess("propose_note", "reviewer", "A");
    expect(access.allowed).toBe(true);

    expect(canWriteNoteType("reviewer", "issue")).toBe(true);
    expect(canWriteNoteType("reviewer", "decision")).toBe(true);
    expect(canWriteNoteType("reviewer", "repo_map")).toBe(false);
    expect(canWriteNoteType("reviewer", "file_summary")).toBe(false);
  });

  it("observer can only read limited note types", () => {
    expect(canReadNoteType("observer", "issue")).toBe(true);
    expect(canReadNoteType("observer", "decision")).toBe(true);
    expect(canReadNoteType("observer", "change_note")).toBe(true);
    expect(canReadNoteType("observer", "gotcha")).toBe(false);
    expect(canReadNoteType("observer", "runbook")).toBe(false);
  });

  it("admin has wildcard access", () => {
    expect(checkToolAccess("propose_patch", "admin", "A").allowed).toBe(true);
    expect(checkToolAccess("propose_note", "admin", "A").allowed).toBe(true);
    expect(checkToolAccess("anything_custom", "admin", "A").allowed).toBe(true);
  });

  // 0 violations required
  it("Tier B cannot broadcast", () => {
    const access = checkToolAccess("broadcast", "observer", "B");
    expect(access.allowed).toBe(false);
  });

  it("Tier B cannot claim files", () => {
    const access = checkToolAccess("claim_files", "observer", "B");
    expect(access.allowed).toBe(false);
  });
});
