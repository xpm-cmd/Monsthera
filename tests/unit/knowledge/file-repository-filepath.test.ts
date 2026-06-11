import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FileSystemKnowledgeArticleRepository } from "../../../src/knowledge/file-repository.js";
import { KnowledgeService } from "../../../src/knowledge/service.js";
import { parseMarkdown } from "../../../src/knowledge/markdown.js";
import { slug } from "../../../src/core/types.js";
import { ErrorCode } from "../../../src/core/errors.js";
import type { Logger } from "../../../src/core/logger.js";

/**
 * P0-B (Banyan ISSUE-004) — `KnowledgeArticle.filePath` runtime metadata.
 *
 * Externally authored corpora (Option A drop-ins) name files by id
 * (`k-91-HB-037-<slug>.md`) while frontmatter `slug:` stays clean, so any
 * surface that reconstructs `notes/<slug>.md` produces dangling links. The
 * file repository is the only layer that knows the real path; it must expose
 * it at read time as RUNTIME metadata — and never persist it into the
 * on-disk frontmatter.
 */

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-k-filepath-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Write exact bytes to notes/<fileName> (bypasses the repository). */
async function seedRaw(fileName: string, raw: string): Promise<void> {
  const notesDir = path.join(root, "notes");
  await fs.mkdir(notesDir, { recursive: true });
  await fs.writeFile(path.join(notesDir, fileName), raw, "utf-8");
}

const ID_NAMED_FILE = "k-99-99-test-some-slug.md";
const ID_NAMED_RAW = [
  "---",
  "id: k-9999test",
  "title: Externally Authored Note",
  "slug: some-slug",
  "category: research",
  "tags: []",
  "codeRefs: []",
  "references: []",
  "createdAt: 2026-06-01T00:00:00.000Z",
  "updatedAt: 2026-06-01T00:00:00.000Z",
  "---",
  "",
  "Body of the externally authored note.",
].join("\n");

describe("FileSystemKnowledgeArticleRepository — filePath runtime metadata", () => {
  it("populates filePath with the real relative path for an ID-named file (findMany scan)", async () => {
    await seedRaw(ID_NAMED_FILE, ID_NAMED_RAW);
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const all = await repo.findMany();
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value).toHaveLength(1);
    expect(all.value[0]?.slug).toBe("some-slug");
    expect(all.value[0]?.filePath).toBe("notes/k-99-99-test-some-slug.md");
  });

  it("populates filePath on findById", async () => {
    await seedRaw(ID_NAMED_FILE, ID_NAMED_RAW);
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const found = await repo.findById("k-9999test");
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.filePath).toBe("notes/k-99-99-test-some-slug.md");
  });

  it("never persists filePath into on-disk frontmatter (update round-trip)", async () => {
    const repo = new FileSystemKnowledgeArticleRepository(root);
    const created = await repo.create({
      title: "Purity Check",
      category: "context",
      content: "Original body.",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Minimal-diff write path: frontmatter-only edit.
    const tagEdit = await repo.update(created.value.id, { tags: ["x"] });
    expect(tagEdit.ok).toBe(true);

    // Full-serialize write path: a body edit declines the minimal-diff patch.
    const bodyEdit = await repo.update(created.value.id, { content: "New body." });
    expect(bodyEdit.ok).toBe(true);

    const raw = await fs.readFile(
      path.join(root, "notes", `${created.value.slug}.md`),
      "utf-8",
    );
    expect(raw).not.toMatch(/^filePath:/m);
    const parsed = parseMarkdown(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.value.frontmatter)).not.toContain("filePath");

    // The runtime view still knows where the file lives after re-reading.
    const reread = await repo.findById(created.value.id);
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.filePath).toBe(`notes/${created.value.slug}.md`);
  });
});

/**
 * Follow-up to P0-B (gotcha recorded in PR-16): every WRITE still resolved
 * its target as `notes/<slug>.md`, so updating an ID-named article wrote a
 * brand-new slug-named file and left the original behind, and deleting one
 * was a silent no-op (`force: true` swallowed the ENOENT). Writes must land
 * on the file the article was actually read from.
 */
describe("FileSystemKnowledgeArticleRepository — writes honor filePath (ID-named files)", () => {
  it("update() with a body edit rewrites the SAME ID-named file, no duplicate", async () => {
    await seedRaw(ID_NAMED_FILE, ID_NAMED_RAW);
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const updated = await repo.update("k-9999test", { content: "Edited body." });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;

    const entries = await fs.readdir(path.join(root, "notes"));
    expect(entries).toEqual([ID_NAMED_FILE]);
    const raw = await fs.readFile(path.join(root, "notes", ID_NAMED_FILE), "utf-8");
    expect(raw).toContain("Edited body.");
    expect(updated.value.filePath).toBe(`notes/${ID_NAMED_FILE}`);
  });

  it("update() with a frontmatter-only edit patches the SAME ID-named file (minimal-diff path)", async () => {
    await seedRaw(ID_NAMED_FILE, ID_NAMED_RAW);
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const updated = await repo.update("k-9999test", { tags: ["lean"] });
    expect(updated.ok).toBe(true);

    const entries = await fs.readdir(path.join(root, "notes"));
    expect(entries).toEqual([ID_NAMED_FILE]);
    const raw = await fs.readFile(path.join(root, "notes", ID_NAMED_FILE), "utf-8");
    expect(raw).toContain("Body of the externally authored note.");

    const reread = await repo.findById("k-9999test");
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.tags).toEqual(["lean"]);
  });

  it("update() with a title change moves the ID-named file to the canonical slug path", async () => {
    await seedRaw(ID_NAMED_FILE, ID_NAMED_RAW);
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const updated = await repo.update("k-9999test", { title: "Renamed Externally" });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.slug).toBe("renamed-externally");

    const entries = await fs.readdir(path.join(root, "notes"));
    expect(entries).toEqual(["renamed-externally.md"]);
    expect(updated.value.filePath).toBe("notes/renamed-externally.md");
  });

  it("writeWithSlug (explicit rename) on an ID-named file removes the original", async () => {
    await seedRaw(ID_NAMED_FILE, ID_NAMED_RAW);
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const renamed = await repo.writeWithSlug("k-9999test", { slug: slug("explicit-target") });
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;

    const entries = await fs.readdir(path.join(root, "notes"));
    expect(entries).toEqual(["explicit-target.md"]);
    expect(renamed.value.filePath).toBe("notes/explicit-target.md");
  });

  it("delete() on an ID-named file removes the real file (not a silent no-op)", async () => {
    await seedRaw(ID_NAMED_FILE, ID_NAMED_RAW);
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const deleted = await repo.delete("k-9999test");
    expect(deleted.ok).toBe(true);

    const entries = await fs.readdir(path.join(root, "notes"));
    expect(entries).toEqual([]);
  });
});

/**
 * Follow-up w-c09d7wa9: `findBySlug` was purely path-derived
 * (`notes/<slug>.md`), so an ID-named article resolved as NotFound — and the
 * explicit-slug collision check in `KnowledgeService.createArticle` (which
 * delegates to `findBySlug`) silently missed the collision. When the
 * slug-named fast path misses, `findBySlug` must fall back to a frontmatter
 * scan.
 */
describe("FileSystemKnowledgeArticleRepository — findBySlug resolves ID-named files", () => {
  const noopLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => noopLogger,
  };

  it("findBySlug returns the article when its file is ID-named (frontmatter scan)", async () => {
    await seedRaw(ID_NAMED_FILE, ID_NAMED_RAW);
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const found = await repo.findBySlug(slug("some-slug"));
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.id).toBe("k-9999test");
    expect(found.value.filePath).toBe(`notes/${ID_NAMED_FILE}`);
  });

  it("findBySlug still returns slug-shaped NotFound when no article carries the slug", async () => {
    await seedRaw(ID_NAMED_FILE, ID_NAMED_RAW);
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const missing = await repo.findBySlug(slug("missing-slug"));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.error.code).toBe(ErrorCode.NOT_FOUND);
    expect(missing.error.message).toContain("slug:missing-slug");
  });

  it("create with an explicit slug colliding with an ID-named article returns AlreadyExists", async () => {
    await seedRaw(ID_NAMED_FILE, ID_NAMED_RAW);
    const repo = new FileSystemKnowledgeArticleRepository(root);
    const service = new KnowledgeService({ knowledgeRepo: repo, logger: noopLogger });

    const result = await service.createArticle({
      title: "A Different Title",
      category: "context",
      content: "Body that must not land.",
      slug: "some-slug",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.ALREADY_EXISTS);

    // No second article was written: the ID-named file is still alone.
    const entries = await fs.readdir(path.join(root, "notes"));
    expect(entries).toEqual([ID_NAMED_FILE]);
  });
});
