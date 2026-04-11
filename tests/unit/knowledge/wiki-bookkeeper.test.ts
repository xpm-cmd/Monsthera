import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { WikiBookkeeper } from "../../../src/knowledge/wiki-bookkeeper.js";
import { VALID_PHASES } from "../../../src/core/types.js";
import type { KnowledgeArticle } from "../../../src/knowledge/repository.js";
import type { WorkArticle } from "../../../src/work/repository.js";
import { articleId, workId, agentId, timestamp, slug, WorkPhase, WorkTemplate, Priority } from "../../../src/core/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeKnowledge(overrides: Partial<KnowledgeArticle> = {}): KnowledgeArticle {
  return {
    id: articleId("k-test0001"),
    title: "Test Knowledge",
    slug: slug("test-knowledge"),
    category: "engineering",
    content: "Test content for knowledge article.",
    tags: [],
    codeRefs: [],
    references: [],
    createdAt: timestamp("2026-01-01T00:00:00.000Z"),
    updatedAt: timestamp("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeWork(overrides: Partial<WorkArticle> = {}): WorkArticle {
  return {
    id: workId("w-test0001"),
    title: "Test Work",
    template: WorkTemplate.FEATURE,
    phase: WorkPhase.PLANNING,
    priority: Priority.MEDIUM,
    author: agentId("agent-1"),
    enrichmentRoles: [],
    reviewers: [],
    phaseHistory: [{ phase: WorkPhase.PLANNING, enteredAt: timestamp() }],
    tags: [],
    references: [],
    codeRefs: [],
    dependencies: [],
    blockedBy: [],
    content: "",
    createdAt: timestamp(),
    updatedAt: timestamp(),
    ...overrides,
  };
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("WikiBookkeeper", () => {
  let tmpDir: string;
  let bookkeeper: WikiBookkeeper;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-bk-test-"));
    bookkeeper = new WikiBookkeeper(tmpDir, noopLogger);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("rebuildIndex phase ordering", () => {
    it("uses phase order matching VALID_PHASES", async () => {
      // Create work articles in every valid phase
      const articles = Object.values(WorkPhase).map((phase, i) =>
        makeWork({
          id: workId(`w-phase-${i}`),
          title: `Work in ${phase}`,
          phase,
        }),
      );

      await bookkeeper.rebuildIndex([], articles);

      const index = await fs.readFile(path.join(tmpDir, "index.md"), "utf-8");

      // Every phase used should be a valid WorkPhase
      for (const phase of Object.values(WorkPhase)) {
        expect(index).toContain(`### ${phase}`);
      }
    });

    it("does not include legacy 'complete' phase", async () => {
      await bookkeeper.rebuildIndex([], [
        makeWork({ phase: WorkPhase.DONE }),
      ]);

      const index = await fs.readFile(path.join(tmpDir, "index.md"), "utf-8");
      expect(index).not.toContain("complete");
    });

    it("orders implementation between enrichment and review", async () => {
      const articles = [
        makeWork({ id: workId("w-1"), title: "Review item", phase: WorkPhase.REVIEW }),
        makeWork({ id: workId("w-2"), title: "Enrichment item", phase: WorkPhase.ENRICHMENT }),
        makeWork({ id: workId("w-3"), title: "Implementation item", phase: WorkPhase.IMPLEMENTATION }),
      ];

      await bookkeeper.rebuildIndex([], articles);

      const index = await fs.readFile(path.join(tmpDir, "index.md"), "utf-8");
      const enrichmentPos = index.indexOf("### enrichment");
      const implementationPos = index.indexOf("### implementation");
      const reviewPos = index.indexOf("### review");

      expect(enrichmentPos).toBeGreaterThan(-1);
      expect(implementationPos).toBeGreaterThan(-1);
      expect(reviewPos).toBeGreaterThan(-1);
      expect(implementationPos).toBeGreaterThan(enrichmentPos);
      expect(reviewPos).toBeGreaterThan(implementationPos);
    });
  });

  describe("appendLog", () => {
    it("creates log file with header on first append", async () => {
      await bookkeeper.appendLog("create", "knowledge", "Test article");

      const log = await fs.readFile(path.join(tmpDir, "log.md"), "utf-8");
      expect(log).toContain("# Monsthera Log");
      expect(log).toContain("create knowledge | Test article");
    });
  });
});
