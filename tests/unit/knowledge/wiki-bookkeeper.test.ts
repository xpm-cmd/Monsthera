import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { WikiBookkeeper } from "../../../src/knowledge/wiki-bookkeeper.js";
import type { KnowledgeArticle } from "../../../src/knowledge/repository.js";
import type { WorkArticle } from "../../../src/work/repository.js";
import type { Logger } from "../../../src/core/logger.js";
import { articleId, slug as toSlug, workId, agentId, timestamp, WorkPhase, WorkTemplate, Priority } from "../../../src/core/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

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

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
};

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

  describe("policy category rendering", () => {
    function makePolicy(overrides: Partial<KnowledgeArticle> = {}): KnowledgeArticle {
      return {
        id: articleId("k-policy-1"),
        title: "Policy: auth requires security",
        slug: toSlug("policy-auth-security"),
        category: "policy",
        content: "body",
        tags: [],
        codeRefs: [],
        references: [],
        createdAt: timestamp(),
        updatedAt: timestamp(),
        extraFrontmatter: {
          policy_applies_templates: ["feature"],
          policy_phase_transition: "enrichment->implementation",
          policy_requires_roles: ["security"],
          policy_requires_articles: [],
        },
        ...overrides,
      };
    }

    it("renders the policy category as a table with applies-to and requires", async () => {
      await bookkeeper.rebuildIndex([makePolicy()], []);
      const index = await fs.readFile(path.join(tmpDir, "index.md"), "utf-8");
      expect(index).toContain("### policy");
      expect(index).toContain("| Policy | Templates | Transition | Requires Roles | Requires Articles |");
      expect(index).toContain("enrichment → implementation");
      expect(index).toContain("feature");
      expect(index).toContain("security");
      expect(index).toContain("(notes/policy-auth-security.md)");
    });

    it("shows em-dash for missing policy fields", async () => {
      const bare = makePolicy({ extraFrontmatter: {} });
      await bookkeeper.rebuildIndex([bare], []);
      const index = await fs.readFile(path.join(tmpDir, "index.md"), "utf-8");
      // Template, transition, requires-roles, requires-articles all missing ⇒ four em-dashes in the row
      expect(index).toMatch(/\| —\s*\|\s*—\s*\|\s*—\s*\|\s*—\s*\|/);
    });
  });
});
