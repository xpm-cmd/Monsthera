import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FileSystemKnowledgeArticleRepository } from "../../../src/knowledge/file-repository.js";
import { slug } from "../../../src/core/types.js";

/**
 * Worktree fallback tests for FileSystemKnowledgeArticleRepository.
 *
 * The fallback layer is what makes `monsthera knowledge get
 * handoff-ses-X` work when the handoff article was generated in a
 * different worktree (or main). Beyond handoffs it also surfaces
 * shared knowledge across feature branches; both shapes are exercised
 * here.
 */

interface SeedArticle {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly category?: string;
  readonly content?: string;
}

async function seed(dir: string, a: SeedArticle): Promise<void> {
  const fm = [
    "---",
    `id: ${a.id}`,
    `title: ${a.title}`,
    `slug: ${a.slug}`,
    `category: ${a.category ?? "context"}`,
    "tags: []",
    "codeRefs: []",
    "references: []",
    "createdAt: 2026-05-15T10:00:00Z",
    "updatedAt: 2026-05-15T10:00:00Z",
    "---",
    "",
    a.content ?? `Body of ${a.title}`,
  ].join("\n");
  await fs.mkdir(path.join(dir, "notes"), { recursive: true });
  await fs.writeFile(path.join(dir, "notes", `${a.slug}.md`), fm, "utf-8");
}

let primary: string;
let fallback: string;

beforeEach(async () => {
  primary = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-k-fallback-primary-"));
  fallback = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-k-fallback-fallback-"));
});

afterEach(async () => {
  await fs.rm(primary, { recursive: true, force: true });
  await fs.rm(fallback, { recursive: true, force: true });
});

describe("FileSystemKnowledgeArticleRepository — worktree fallback", () => {
  describe("findBySlug", () => {
    it("returns the fallback article when primary doesn't have it", async () => {
      await seed(fallback, {
        id: "k-handoff-from-main",
        title: "Handoff from main worktree",
        slug: "handoff-ses-20260514-100000-claude-code",
        category: "handoff",
      });
      const repo = new FileSystemKnowledgeArticleRepository(primary, fallback);
      const found = await repo.findBySlug(slug("handoff-ses-20260514-100000-claude-code"));
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value.title).toBe("Handoff from main worktree");
    });

    it("primary wins over fallback on slug collision", async () => {
      await seed(primary, {
        id: "k-primary-version",
        title: "Primary version",
        slug: "shared-slug",
      });
      await seed(fallback, {
        id: "k-fallback-version",
        title: "Fallback version",
        slug: "shared-slug",
      });
      const repo = new FileSystemKnowledgeArticleRepository(primary, fallback);
      const found = await repo.findBySlug(slug("shared-slug"));
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value.title).toBe("Primary version");
    });
  });

  describe("findById", () => {
    it("falls back to find by id when only fallback has the article", async () => {
      await seed(fallback, {
        id: "k-only-in-main",
        title: "Only in main",
        slug: "only-in-main",
      });
      const repo = new FileSystemKnowledgeArticleRepository(primary, fallback);
      const found = await repo.findById("k-only-in-main");
      expect(found.ok).toBe(true);
      if (!found.ok) return;
      expect(found.value.id).toBe("k-only-in-main");
    });
  });

  describe("findMany / list", () => {
    it("returns the union of primary + fallback articles", async () => {
      await seed(primary, { id: "k-primary", title: "P", slug: "p" });
      await seed(fallback, { id: "k-fallback-1", title: "F1", slug: "f1" });
      await seed(fallback, { id: "k-fallback-2", title: "F2", slug: "f2" });

      const repo = new FileSystemKnowledgeArticleRepository(primary, fallback);
      const all = await repo.findMany();
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.value.length).toBe(3);
      const slugs = all.value.map((a) => a.slug);
      expect(slugs).toContain("p");
      expect(slugs).toContain("f1");
      expect(slugs).toContain("f2");
    });

    it("dedupes by id when primary and fallback both have the same id under different slugs", async () => {
      // Defensive: shouldn't happen in practice (slug is part of the
      // file name), but we want to be predictable if it does.
      await seed(primary, { id: "k-shared-id", title: "Primary", slug: "primary-slug" });
      await seed(fallback, { id: "k-shared-id", title: "Fallback", slug: "fallback-slug" });

      const repo = new FileSystemKnowledgeArticleRepository(primary, fallback);
      const all = await repo.findMany();
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.value.length).toBe(1);
      expect(all.value[0]!.title).toBe("Primary");
    });
  });

  describe("writes do not touch the fallback dir", () => {
    it("create writes only to primary", async () => {
      const repo = new FileSystemKnowledgeArticleRepository(primary, fallback);
      const created = await repo.create({
        title: "New article",
        category: "context",
        content: "body",
        tags: [],
        codeRefs: [],
        references: [],
      });
      expect(created.ok).toBe(true);

      const primaryFiles = await fs.readdir(path.join(primary, "notes"));
      const fallbackFiles = await fs.readdir(fallback).catch(() => []);
      expect(primaryFiles.length).toBeGreaterThan(0);
      expect(fallbackFiles).not.toContain("notes");
    });
  });

  describe("graceful failure on fallback errors", () => {
    it("surfaces primary results when fallback dir is unreadable", async () => {
      // Point fallback at a path that exists but isn't readable as a
      // directory (use a regular file). The repo should still return
      // primary's articles rather than erroring.
      const badFallbackParent = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-bad-fallback-"));
      const filePosingAsRoot = path.join(badFallbackParent, "knowledge");
      await fs.writeFile(filePosingAsRoot, "not a directory", "utf-8");

      await seed(primary, { id: "k-primary-only", title: "Only primary", slug: "only-primary" });
      const repo = new FileSystemKnowledgeArticleRepository(primary, filePosingAsRoot);
      const all = await repo.findMany();
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.value.length).toBe(1);
      expect(all.value[0]!.slug).toBe("only-primary");

      await fs.rm(badFallbackParent, { recursive: true, force: true });
    });
  });
});

describe("FileSystemKnowledgeArticleRepository — no fallback (regression guard)", () => {
  it("default constructor keeps pre-fallback behaviour", async () => {
    await seed(primary, { id: "k-primary", title: "P", slug: "p" });
    await seed(fallback, { id: "k-fallback", title: "F", slug: "f" });
    const repo = new FileSystemKnowledgeArticleRepository(primary); // no fallback
    const all = await repo.findMany();
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.length).toBe(1);
    expect(all.value[0]!.slug).toBe("p");
  });
});
