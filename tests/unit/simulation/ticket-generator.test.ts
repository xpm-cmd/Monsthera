import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../../src/db/schema.js";
import { generateCorpus, type GeneratorConfig } from "../../../src/simulation/ticket-generator.js";
import type { TicketDescriptor, PlanningEvidence } from "../../../src/simulation/types.js";

// ---------------------------------------------------------------------------
// Test DB setup (in-memory, matches integration pattern)
// ---------------------------------------------------------------------------

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // Create tables from schema
  sqlite.exec([
    "CREATE TABLE IF NOT EXISTS repos (",
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
    "  name TEXT NOT NULL,",
    "  path TEXT NOT NULL,",
    "  remote_url TEXT",
    ")",
  ].join("\n"));
  sqlite.exec([
    "CREATE TABLE IF NOT EXISTS files (",
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
    "  repo_id INTEGER NOT NULL REFERENCES repos(id),",
    "  path TEXT NOT NULL,",
    "  language TEXT,",
    "  content_hash TEXT,",
    "  summary TEXT,",
    "  symbols_json TEXT,",
    "  has_secrets INTEGER DEFAULT 0",
    ")",
  ].join("\n"));
  sqlite.exec([
    "CREATE TABLE IF NOT EXISTS imports (",
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
    "  source_file_id INTEGER NOT NULL REFERENCES files(id),",
    "  target_path TEXT NOT NULL,",
    "  kind TEXT NOT NULL",
    ")",
  ].join("\n"));
  sqlite.exec([
    "CREATE TABLE IF NOT EXISTS tickets (",
    "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
    "  repo_id INTEGER NOT NULL REFERENCES repos(id),",
    "  ticket_id TEXT NOT NULL UNIQUE,",
    "  title TEXT NOT NULL,",
    "  description TEXT NOT NULL,",
    "  status TEXT NOT NULL DEFAULT 'backlog',",
    "  severity TEXT NOT NULL DEFAULT 'medium',",
    "  priority INTEGER NOT NULL DEFAULT 5,",
    "  tags_json TEXT,",
    "  affected_paths_json TEXT,",
    "  acceptance_criteria TEXT,",
    "  creator_agent_id TEXT NOT NULL,",
    "  creator_session_id TEXT NOT NULL,",
    "  assignee_agent_id TEXT,",
    "  resolved_by_agent_id TEXT,",
    "  commit_sha TEXT NOT NULL,",
    "  required_roles_json TEXT,",
    "  created_at TEXT NOT NULL,",
    "  updated_at TEXT NOT NULL",
    ")",
  ].join("\n"));

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlanningEvidence(): PlanningEvidence {
  return {
    summary: "Test ticket for simulation.",
    approach: "Apply targeted changes.",
    affectedAreas: ["src/test-file.ts"],
    riskAssessment: "Low risk.",
    testPlan: "Run existing tests.",
  };
}

function makeManualDescriptor(
  overrides?: Partial<TicketDescriptor>,
): TicketDescriptor {
  return {
    corpusId: "manual-001",
    title: "Add logging to coordination bus",
    description: "Add structured logging to the coordination bus for better observability in production.",
    affectedPaths: [],
    tags: ["autoresearch", "manual"],
    severity: "medium",
    priority: 5,
    acceptanceCriteria: "Logging added. Tests pass. No regressions.",
    source: "manual",
    atomicityLevel: "micro",
    suggestedModel: "haiku",
    estimatedLines: 30,
    planningEvidence: makePlanningEvidence(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ticket-generator", () => {
  let tempDir: string;
  let db: ReturnType<typeof createTestDb>["db"];
  let sqlite: ReturnType<typeof createTestDb>["sqlite"];
  let repoId: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "agora-sim-gen-"));
    const testDb = createTestDb();
    db = testDb.db;
    sqlite = testDb.sqlite;

    // Insert a test repo
    sqlite.exec(
      `INSERT INTO repos (name, path, remote_url) VALUES ('test-repo', '${tempDir}', NULL)`,
    );
    repoId = (sqlite.prepare("SELECT id FROM repos WHERE name = 'test-repo'").get() as any).id;
  });

  afterEach(async () => {
    sqlite.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("generates empty corpus when no sources available", async () => {
    const config: GeneratorConfig = {
      repoPath: tempDir,
      db,
      repoId,
      gitCommit: "abc123",
      skipSources: ["backlog", "auto", "manual"],
    };

    const result = await generateCorpus(config);

    expect(result.corpus.descriptors).toHaveLength(0);
    expect(result.sources.backlog).toBe(0);
    expect(result.sources.autoDetected).toBe(0);
    expect(result.sources.manual).toBe(0);
  });

  it("passes manual descriptors through anti-basura", async () => {
    const validManual = makeManualDescriptor({
      affectedPaths: [],
    });

    const config: GeneratorConfig = {
      repoPath: tempDir,
      db,
      repoId,
      gitCommit: "abc123",
      manualDescriptors: [validManual],
      skipSources: ["backlog", "auto"],
    };

    const result = await generateCorpus(config);

    expect(result.sources.manual).toBe(1);
    expect(result.corpus.descriptors).toHaveLength(1);
    expect(result.corpus.descriptors[0]!.title).toBe(validManual.title);
  });

  it("rejects manual descriptors that fail anti-basura", async () => {
    const badManual = makeManualDescriptor({
      title: "The logging is bad",
    });

    const config: GeneratorConfig = {
      repoPath: tempDir,
      db,
      repoId,
      gitCommit: "abc123",
      manualDescriptors: [badManual],
      skipSources: ["backlog", "auto"],
    };

    const result = await generateCorpus(config);

    expect(result.sources.manual).toBe(0);
    expect(result.corpus.descriptors).toHaveLength(0);
    expect(result.corpus.rejections).toHaveLength(1);
    expect(result.corpus.rejections[0]!.reason).toBe("not_actionable");
  });

  it("respects targetCorpusSize limit", async () => {
    const topics = ["parser", "indexer", "dashboard", "coordination bus", "workflow engine"];
    const manuals = topics.map((topic, i) =>
      makeManualDescriptor({
        corpusId: `manual-${i}`,
        title: `Add comprehensive logging to ${topic}`,
        affectedPaths: [],
      }),
    );

    const config: GeneratorConfig = {
      repoPath: tempDir,
      db,
      repoId,
      gitCommit: "abc123",
      manualDescriptors: manuals,
      targetCorpusSize: 3,
      skipSources: ["backlog", "auto"],
    };

    const result = await generateCorpus(config);

    expect(result.corpus.descriptors).toHaveLength(3);
  });

  it("detects auto issues from source files", async () => {
    // Create a TypeScript file with high complexity (many if/for/while)
    await mkdir(join(tempDir, "src"), { recursive: true });
    const complexCode = [
      "export function complexFunction(x: number, y: number): number {",
      "  if (x > 0) {",
      "    if (y > 0) {",
      "      for (let i = 0; i < x; i++) {",
      "        if (i % 2 === 0) {",
      "          while (y > 0) {",
      "            if (x > y) {",
      "              for (let j = 0; j < y; j++) {",
      "                if (j > i) {",
      "                  if (x + y > 100) {",
      "                    return x * y;",
      "                  }",
      "                  if (x - y < 0) {",
      "                    return 0;",
      "                  }",
      "                  switch (x) {",
      "                    case 1: return 1;",
      "                    case 2: return 2;",
      "                    case 3: return 3;",
      "                    case 4: return 4;",
      "                    case 5: return 5;",
      "                    default: return -1;",
      "                  }",
      "                }",
      "              }",
      "            }",
      "            y--;",
      "          }",
      "        }",
      "      }",
      "    }",
      "  }",
      "  return x + y;",
      "}",
    ].join("\n");
    await writeFile(join(tempDir, "src/complex.ts"), complexCode);

    // Index the file in the DB
    sqlite.exec(
      `INSERT INTO files (repo_id, path, language) VALUES (${repoId}, 'src/complex.ts', 'typescript')`,
    );

    const config: GeneratorConfig = {
      repoPath: tempDir,
      db,
      repoId,
      gitCommit: "abc123",
      skipSources: ["backlog", "manual"],
    };

    const result = await generateCorpus(config);

    // Should detect high complexity and/or deep nesting
    expect(result.sources.autoDetected).toBeGreaterThan(0);
    const allTags = result.corpus.descriptors.map((d) => d.tags).flat();
    // Auto-detected tickets include the signal name as a tag
    const hasComplexitySignal = allTags.some(
      (t) => t === "high_complexity" || t === "deep_nesting" || t === "missing_tests",
    );
    expect(hasComplexitySignal).toBe(true);
  });

  it("records corpus metadata", async () => {
    const config: GeneratorConfig = {
      repoPath: tempDir,
      db,
      repoId,
      gitCommit: "test-sha-456",
      manualDescriptors: [makeManualDescriptor({ affectedPaths: [] })],
      skipSources: ["backlog", "auto"],
    };

    const result = await generateCorpus(config);

    expect(result.corpus.gitCommit).toBe("test-sha-456");
    expect(result.corpus.generatedAt).toBeTruthy();
    expect(typeof result.corpus.generatedAt).toBe("string");
  });

  describe("backlog atomization", () => {
    it("atomizes tickets with affectedPaths into sub-tasks", async () => {
      // Create a simple source file
      await mkdir(join(tempDir, "src"), { recursive: true });
      const simpleCode = [
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "export function subtract(a: number, b: number): number {",
        "  return a - b;",
        "}",
      ].join("\n");
      await writeFile(join(tempDir, "src/math.ts"), simpleCode);

      // Create a backlog ticket pointing to that file
      const now = new Date().toISOString();
      sqlite.exec([
        "INSERT INTO tickets (",
        "  repo_id, ticket_id, title, description, status,",
        "  severity, priority, tags_json, affected_paths_json,",
        "  acceptance_criteria, creator_agent_id, creator_session_id,",
        "  commit_sha, created_at, updated_at",
        `) VALUES (`,
        `  ${repoId}, 'TKT-test0001', 'Improve math module', 'Make the math module better',`,
        `  'approved', 'medium', 5, '["improvement"]',`,
        `  '["src/math.ts"]', 'Tests pass', 'agent-1', 'session-1',`,
        `  'abc123', '${now}', '${now}'`,
        ")",
      ].join("\n"));

      const config: GeneratorConfig = {
        repoPath: tempDir,
        db,
        repoId,
        gitCommit: "abc123",
        skipSources: ["auto", "manual"],
      };

      const result = await generateCorpus(config);

      // Should produce at least one atomized ticket from the backlog ticket
      expect(result.sources.backlog).toBeGreaterThan(0);
      // Atomized tickets should reference the parent
      for (const d of result.corpus.descriptors) {
        expect(d.parentTicketId).toBe("TKT-test0001");
        expect(d.source).toBe("backlog_atomized");
      }
    });

    it("skips tickets with no affectedPaths", async () => {
      const now = new Date().toISOString();
      sqlite.exec([
        "INSERT INTO tickets (",
        "  repo_id, ticket_id, title, description, status,",
        "  severity, priority, tags_json, affected_paths_json,",
        "  acceptance_criteria, creator_agent_id, creator_session_id,",
        "  commit_sha, created_at, updated_at",
        `) VALUES (`,
        `  ${repoId}, 'TKT-nopath01', 'Vague improvement', 'Something needs improvement',`,
        `  'backlog', 'medium', 5, '[]', '[]',`,
        `  'Tests pass', 'agent-1', 'session-1',`,
        `  'abc123', '${now}', '${now}'`,
        ")",
      ].join("\n"));

      const config: GeneratorConfig = {
        repoPath: tempDir,
        db,
        repoId,
        gitCommit: "abc123",
        skipSources: ["auto", "manual"],
      };

      const result = await generateCorpus(config);

      expect(result.sources.backlog).toBe(0);
    });
  });
});
