import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FileSystemKnowledgeArticleRepository } from "../../../src/knowledge/file-repository.js";
import { parseMarkdown } from "../../../src/knowledge/markdown.js";

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
