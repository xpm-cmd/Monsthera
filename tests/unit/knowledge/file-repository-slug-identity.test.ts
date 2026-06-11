import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FileSystemKnowledgeArticleRepository } from "../../../src/knowledge/file-repository.js";
import { slug } from "../../../src/core/types.js";
import { NotFoundError } from "../../../src/core/errors.js";

/**
 * H1 — slug identity decision.
 *
 * findBySlug used to try `notes/<slug>.md` directly before scanning
 * frontmatter (the scan was expensive pre-cache, so the path-derived fast
 * path earned its keep). With stat-cached scans the fast path's only
 * remaining effect was a semantic leak: a file whose NAME doesn't match
 * its frontmatter slug resolved by filename stem too, giving one article
 * two identities. Decision: frontmatter `slug:` is the single read-path
 * identity; the filename is physical layout, not identity. (G1 already
 * made frontmatter authoritative for ID-named files — this finishes it.)
 */

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-k-slugid-"));
  await fs.mkdir(path.join(root, "notes"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function seedDivergent(): Promise<void> {
  // Filename stem "foo", frontmatter slug "bar".
  const raw = [
    "---",
    "id: k-dvrg0001",
    "title: Divergent",
    "slug: bar",
    "category: context",
    "tags: []",
    "codeRefs: []",
    "references: []",
    "createdAt: 2026-06-01T00:00:00.000Z",
    "updatedAt: 2026-06-01T00:00:00.000Z",
    "---",
    "",
    "Body",
    "",
  ].join("\n");
  await fs.writeFile(path.join(root, "notes", "foo.md"), raw, "utf-8");
}

describe("findBySlug identity = frontmatter slug (H1 decision)", () => {
  it("resolves by frontmatter slug even when the filename differs", async () => {
    await seedDivergent();
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const result = await repo.findBySlug(slug("bar"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe("k-dvrg0001");
    expect(result.value.filePath).toBe("notes/foo.md");
  });

  it("does NOT resolve by filename stem when frontmatter says otherwise", async () => {
    await seedDivergent();
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const result = await repo.findBySlug(slug("foo"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(NotFoundError);
  });
});
