import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

const execFileAsync = promisify(execFile);

function makeKnowledge(overrides: Partial<KnowledgeArticle> = {}): KnowledgeArticle {
  return {
    id: articleId("k-test0001"),
    title: "Test Knowledge",
    slug: toSlug("test-knowledge"),
    category: "context",
    content: "Body of the test knowledge article.",
    tags: [],
    codeRefs: [],
    references: [],
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

    it("links the real filePath in the policy table when present", async () => {
      const policy = makePolicy({ filePath: "notes/k-77-policy-auth-security.md" });
      await bookkeeper.rebuildIndex([policy], []);
      const index = await fs.readFile(path.join(tmpDir, "index.md"), "utf-8");
      expect(index).toContain("(notes/k-77-policy-auth-security.md)");
      expect(index).not.toContain("(notes/policy-auth-security.md)");
    });
  });

  // ─── P0-B (Banyan ISSUE-004): link targets must be the REAL filenames ─────
  //
  // Externally authored corpora (Option A drop-ins) name files by id
  // (`k-91-HB-037-<slug>.md`) while frontmatter `slug:` stays clean. Building
  // links from the slug dangles 100% of them. The repository exposes the real
  // relative path as runtime metadata (`article.filePath`); the bookkeeper
  // must prefer it and only fall back to `notes/<slug>.md` when absent.
  describe("knowledge link targets (filePath)", () => {
    it("links the article's real filePath when present (ID-named external files)", async () => {
      await bookkeeper.rebuildIndex(
        [
          makeKnowledge({
            title: "Unified DBS model",
            slug: toSlug("unified-dbs-model-optimal-schedule"),
            filePath: "notes/k-91-HB-037-unified-dbs-model-optimal-schedule.md",
          }),
        ],
        [],
      );

      const index = await fs.readFile(path.join(tmpDir, "index.md"), "utf-8");
      expect(index).toContain(
        "[Unified DBS model](notes/k-91-HB-037-unified-dbs-model-optimal-schedule.md)",
      );
      expect(index).not.toContain("(notes/unified-dbs-model-optimal-schedule.md)");
    });

    it("falls back to notes/<slug>.md when filePath is absent", async () => {
      await bookkeeper.rebuildIndex(
        [makeKnowledge({ title: "Plain Note", slug: toSlug("plain-note") })],
        [],
      );

      const index = await fs.readFile(path.join(tmpDir, "index.md"), "utf-8");
      expect(index).toContain("[Plain Note](notes/plain-note.md)");
    });
  });

  // ─── P0-A (Banyan ISSUE-005): gitignored articles are local-only ──────────
  //
  // Banyan gitignores `knowledge/notes/handoff-*.md` (session state). A
  // committed index that lists them dangles on every fresh checkout. The
  // bookkeeper asks `git check-ignore` which candidate paths are ignored and
  // omits those articles, adding one transparent count line. Exclusion is
  // gitignore-driven, NOT name-driven: repos that COMMIT their handoffs (like
  // Monsthera itself) keep listing them.
  describe("gitignored (local-only) article exclusion", () => {
    let repoRoot: string;
    let markdownRoot: string;
    let gitBookkeeper: WikiBookkeeper;

    beforeEach(async () => {
      repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-bk-git-"));
      markdownRoot = path.join(repoRoot, "knowledge");
      await fs.mkdir(markdownRoot, { recursive: true });
      gitBookkeeper = new WikiBookkeeper(markdownRoot, noopLogger);
    });

    afterEach(async () => {
      await fs.rm(repoRoot, { recursive: true, force: true });
    });

    async function initGitRepo(gitignore: string): Promise<void> {
      await execFileAsync("git", ["init", "-q"], { cwd: repoRoot });
      await fs.writeFile(path.join(repoRoot, ".gitignore"), gitignore, "utf-8");
    }

    it("omits gitignored knowledge articles and adds the omitted-count line", async () => {
      await initGitRepo("knowledge/notes/handoff-*.md\n");

      await gitBookkeeper.rebuildIndex(
        [
          makeKnowledge({
            id: articleId("k-handoff1"),
            title: "Handoff session 1",
            slug: toSlug("handoff-ses-1"),
            filePath: "notes/handoff-ses-1.md",
          }),
          makeKnowledge({
            id: articleId("k-normal1"),
            title: "Normal note",
            slug: toSlug("normal-note"),
          }),
        ],
        [],
      );

      const index = await fs.readFile(path.join(markdownRoot, "index.md"), "utf-8");
      expect(index).toContain("[Normal note](notes/normal-note.md)");
      expect(index).not.toContain("handoff-ses-1");
      expect(index).toContain("> 1 local-only article(s) omitted (gitignored).");
      // The catalog count reflects what is actually listed.
      expect(index).toContain("catalog of 1 knowledge articles");
    });

    it("omits gitignored work articles too", async () => {
      await initGitRepo("knowledge/work-articles/w-local-*.md\n");

      await gitBookkeeper.rebuildIndex(
        [],
        [
          makeWork({ id: workId("w-local-1"), title: "Local-only scratch work" }),
          makeWork({ id: workId("w-shared-1"), title: "Shared work" }),
        ],
      );

      const index = await fs.readFile(path.join(markdownRoot, "index.md"), "utf-8");
      expect(index).toContain("[Shared work](work-articles/w-shared-1.md)");
      expect(index).not.toContain("w-local-1");
      expect(index).toContain("> 1 local-only article(s) omitted (gitignored).");
    });

    it("lists everything when the markdown root is not inside a git repo", async () => {
      // No `git init` here — graceful degradation preserves current behavior.
      await gitBookkeeper.rebuildIndex(
        [
          makeKnowledge({
            id: articleId("k-handoff1"),
            title: "Handoff session 1",
            slug: toSlug("handoff-ses-1"),
            filePath: "notes/handoff-ses-1.md",
          }),
          makeKnowledge({
            id: articleId("k-normal1"),
            title: "Normal note",
            slug: toSlug("normal-note"),
          }),
        ],
        [],
      );

      const index = await fs.readFile(path.join(markdownRoot, "index.md"), "utf-8");
      expect(index).toContain("handoff-ses-1");
      expect(index).toContain("normal-note");
      expect(index).not.toContain("omitted (gitignored)");
    });

    it("adds no omitted line in a git repo when nothing is ignored", async () => {
      await initGitRepo("unrelated-dir/\n");

      await gitBookkeeper.rebuildIndex(
        [makeKnowledge({ title: "Normal note", slug: toSlug("normal-note") })],
        [],
      );

      const index = await fs.readFile(path.join(markdownRoot, "index.md"), "utf-8");
      expect(index).toContain("(notes/normal-note.md)");
      expect(index).not.toContain("omitted (gitignored)");
    });
  });
});
