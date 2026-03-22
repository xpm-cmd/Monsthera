import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { initDatabase } from "../../src/db/init.js";
import * as queries from "../../src/db/queries.js";
import { fullIndex } from "../../src/indexing/indexer.js";

/**
 * Integration test: creates a real git repo with Python, Go, and Rust files,
 * indexes them, then queries the symbol_references table to verify
 * cross-language symbol reference extraction.
 */
describe("symbol-references integration", () => {
  let tmpDir: string;
  let db: ReturnType<typeof initDatabase>["db"];
  let sqlite: ReturnType<typeof initDatabase>["sqlite"];
  let repoId: number;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "monsthera-refs-"));

    execFileSync("git", ["init"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.email", "test@monsthera.dev"], { cwd: tmpDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: tmpDir });

    mkdirSync(join(tmpDir, "src"), { recursive: true });

    writeFileSync(
      join(tmpDir, "src", "app.py"),
      `from db import Database

class App(Base):
    def run(self):
        result = self.db.query("SELECT 1")
        validate(result)
        print("done")
`,
    );

    writeFileSync(
      join(tmpDir, "src", "server.go"),
      `package main

import "fmt"

func HandleRequest(cfg Config) *Response {
\tfmt.Println("handling")
\tresult := db.Query("SELECT 1")
\treturn &Response{Data: result}
}
`,
    );

    writeFileSync(
      join(tmpDir, "src", "handler.rs"),
      `use std::collections::HashMap;

fn process(config: Config) -> Result<Vec<String>, Error> {
    let mut items = Vec::new();
    items.push("hello".to_string());
    HashMap::with_capacity(10);
    items
}

impl Handler for Server {
    fn handle(&self) {}
}
`,
    );

    execFileSync("git", ["add", "-A"], { cwd: tmpDir });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: tmpDir });

    const result = initDatabase({ repoPath: tmpDir, monstheraDir: ".monsthera", dbName: "test.db" });
    db = result.db;
    sqlite = result.sqlite;

    const repo = queries.upsertRepo(db, tmpDir, "test-repo");
    repoId = repo.id;

    await fullIndex({
      repoPath: tmpDir,
      repoId,
      db,
      onProgress: () => {},
    });
  });

  afterAll(() => {
    sqlite.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function getFileId(path: string): number {
    const row = sqlite
      .prepare("SELECT id FROM files WHERE repo_id = ? AND path = ?")
      .get(repoId, path) as { id: number } | undefined;
    expect(row).toBeDefined();
    return row!.id;
  }

  it("indexes Python files with symbol references", () => {
    const fileId = getFileId("src/app.py");
    const refs = queries.getReferencesForFile(db, fileId);

    expect(refs.length).toBeGreaterThan(0);

    const kinds = refs.map((r) => r.referenceKind);
    const targets = refs.map((r) => r.targetName);

    // Call references: validate, print
    const callRefs = refs.filter((r) => r.referenceKind === "call");
    expect(callRefs.length).toBeGreaterThan(0);
    const callTargets = callRefs.map((r) => r.targetName);
    expect(callTargets.some((t) => t === "validate" || t === "print")).toBe(true);

    // Member call references: query (self.db.query)
    const memberCallRefs = refs.filter((r) => r.referenceKind === "member_call");
    expect(memberCallRefs.length).toBeGreaterThan(0);
    const memberTargets = memberCallRefs.map((r) => r.targetName);
    expect(memberTargets).toContain("query");

    // Type references: Base (from class inheritance)
    const typeRefs = refs.filter((r) => r.referenceKind === "type_ref");
    expect(typeRefs.length).toBeGreaterThan(0);
    const typeTargets = typeRefs.map((r) => r.targetName);
    expect(typeTargets).toContain("Base");
  });

  it("indexes Go files with symbol references", () => {
    const fileId = getFileId("src/server.go");
    const refs = queries.getReferencesForFile(db, fileId);

    expect(refs.length).toBeGreaterThan(0);

    // Member call references: Println (fmt.Println)
    const memberCallRefs = refs.filter((r) => r.referenceKind === "member_call");
    expect(memberCallRefs.length).toBeGreaterThan(0);
    const memberTargets = memberCallRefs.map((r) => r.targetName);
    expect(memberTargets).toContain("Println");

    // Type references: Config, Response
    const typeRefs = refs.filter((r) => r.referenceKind === "type_ref");
    expect(typeRefs.length).toBeGreaterThan(0);
    const typeTargets = typeRefs.map((r) => r.targetName);
    expect(typeTargets).toContain("Config");
    expect(typeTargets).toContain("Response");
  });

  it("indexes Rust files with symbol references", () => {
    const fileId = getFileId("src/handler.rs");
    const refs = queries.getReferencesForFile(db, fileId);

    expect(refs.length).toBeGreaterThan(0);

    // Call references: new (Vec::new), with_capacity (HashMap::with_capacity)
    const callRefs = refs.filter((r) => r.referenceKind === "call");
    expect(callRefs.length).toBeGreaterThan(0);
    const callTargets = callRefs.map((r) => r.targetName);
    expect(callTargets.some((t) => t === "new" || t === "with_capacity")).toBe(true);

    // Member call references: push
    const memberCallRefs = refs.filter((r) => r.referenceKind === "member_call");
    expect(memberCallRefs.length).toBeGreaterThan(0);
    const memberTargets = memberCallRefs.map((r) => r.targetName);
    expect(memberTargets).toContain("push");

    // Type references: Config, Result, Vec, Handler, Server
    const typeRefs = refs.filter((r) => r.referenceKind === "type_ref");
    expect(typeRefs.length).toBeGreaterThan(0);
    const typeTargets = typeRefs.map((r) => r.targetName);
    expect(typeTargets).toContain("Config");
    expect(typeTargets).toContain("Result");
    expect(typeTargets).toContain("Vec");
    expect(typeTargets).toContain("Handler");
    expect(typeTargets).toContain("Server");
  });

  it("find_references queries work across languages", () => {
    const results = queries.getReferencesTo(db, repoId, "Config");

    expect(results.length).toBeGreaterThanOrEqual(2);

    const filePaths = results.map((r) => r.files.path);
    expect(filePaths.some((p) => p === "src/server.go")).toBe(true);
    expect(filePaths.some((p) => p === "src/handler.rs")).toBe(true);
  });
});
