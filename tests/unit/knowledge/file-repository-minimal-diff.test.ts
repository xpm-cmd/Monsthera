import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FileSystemKnowledgeArticleRepository } from "../../../src/knowledge/file-repository.js";

/**
 * T5 — minimal-diff frontmatter write on `update`.
 *
 * Reported bug: changing one tag rewrote the WHOLE frontmatter — flow tags,
 * stripped title quotes, reordered custom fields — a huge diff that reads like
 * data loss. Root cause: `update` (slug unchanged) went through
 * `serializeMarkdown`, which canonicalizes every line.
 *
 * These tests pin the fix at the BYTE level: a single-tag edit must touch only
 * the `tags` line and the `updatedAt` line; the quoted colon-title, the body,
 * and any custom (extra) frontmatter must stay byte-identical. They seed raw
 * on-disk bytes directly (NOT via serializeMarkdown) so the fixture's exact
 * formatting is what's under test.
 */

let primary: string;

beforeEach(async () => {
  primary = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-k-min-diff-"));
});

afterEach(async () => {
  await fs.rm(primary, { recursive: true, force: true });
});

/** Write exact bytes to notes/<slug>.md (bypasses serializeMarkdown). */
async function seedRaw(dir: string, slugValue: string, raw: string): Promise<string> {
  const notesDir = path.join(dir, "notes");
  await fs.mkdir(notesDir, { recursive: true });
  const filePath = path.join(notesDir, `${slugValue}.md`);
  await fs.writeFile(filePath, raw, "utf-8");
  return filePath;
}

/** Indices of lines that differ between two files split on "\n". */
function differingLineIndices(before: string, after: string): number[] {
  const a = before.split("\n");
  const b = after.split("\n");
  const diff: number[] = [];
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) diff.push(i);
  }
  return diff;
}

describe("FileSystemKnowledgeArticleRepository — minimal-diff update (T5)", () => {
  it("a single-tag edit changes ONLY the tags + updatedAt lines; quoted title and body stay byte-identical", async () => {
    // Flow tags, a double-quoted colon-title, bare (non-ISO-millis) timestamps,
    // and a body that itself contains a colon — exactly the shapes a full
    // re-serialize would mangle.
    const before = [
      "---",
      "id: k-min-diff-1",
      'title: "API: Design"',
      "slug: api-design-guide",
      "category: guide",
      "tags: [alpha, beta]",
      "codeRefs: []",
      "references: []",
      "createdAt: 2026-05-15T10:00:00Z",
      "updatedAt: 2026-05-15T10:00:00Z",
      "---",
      "",
      "Body paragraph one.",
      "A line with a colon: preserved.",
      "",
    ].join("\n");
    const filePath = await seedRaw(primary, "api-design-guide", before);

    const repo = new FileSystemKnowledgeArticleRepository(primary);
    const result = await repo.update("k-min-diff-1", { tags: ["alpha", "beta", "gamma"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tags).toEqual(["alpha", "beta", "gamma"]);

    const after = await fs.readFile(filePath, "utf-8");
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");

    // The whole point of T5: ONLY the tags line (5) and updatedAt line (9) move.
    expect(differingLineIndices(before, after)).toEqual([5, 9]);

    // Explicit anchors for the regression we're guarding against:
    expect(afterLines[2]).toBe('title: "API: Design"'); // quotes + inner colon intact
    expect(afterLines[5]).toBe("tags: [alpha, beta, gamma]"); // the edit landed
    expect(afterLines[9]).not.toBe(beforeLines[9]); // updatedAt advanced
    expect(afterLines[8]).toBe("createdAt: 2026-05-15T10:00:00Z"); // untouched timestamp
    expect(afterLines[12]).toBe("Body paragraph one."); // body byte-identical
    expect(afterLines[13]).toBe("A line with a colon: preserved.");
  });

  it("falls back to full serialize for block-style frontmatter (no crash, value applied)", async () => {
    // Block-style list — patchFrontmatter returns null, so update takes the
    // existing full-serialize path. This is the safety valve for external /
    // block-style corpora: correctness over minimal diff.
    const before = [
      "---",
      "id: k-min-diff-2",
      "title: Block Style",
      "slug: block-style",
      "category: guide",
      "tags:",
      "  - alpha",
      "  - beta",
      "codeRefs: []",
      "references: []",
      "createdAt: 2026-05-15T10:00:00Z",
      "updatedAt: 2026-05-15T10:00:00Z",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    const filePath = await seedRaw(primary, "block-style", before);

    const repo = new FileSystemKnowledgeArticleRepository(primary);
    const result = await repo.update("k-min-diff-2", { tags: ["alpha", "beta", "gamma"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tags).toEqual(["alpha", "beta", "gamma"]);

    // The change is persisted (full serialize flattened the list to flow, which
    // is acceptable — the alternative would be a half-patched, corrupt file).
    const reread = await repo.findById("k-min-diff-2");
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.tags).toEqual(["alpha", "beta", "gamma"]);

    const after = await fs.readFile(filePath, "utf-8");
    expect(after).toContain("tags: [alpha, beta, gamma]");
  });

  it("preserves custom (extra) frontmatter fields untouched and in place across a minimal-diff edit", async () => {
    // `replicability_score` sits BEFORE tags here — a non-canonical position.
    // Full serialize would move it to the end (after updatedAt); the minimal
    // patch must leave it exactly where it is.
    const before = [
      "---",
      "id: k-min-diff-3",
      "title: Custom Fields",
      "slug: custom-fields",
      "category: policy",
      "replicability_score: 0.85",
      "tags: [alpha, beta]",
      "codeRefs: []",
      "references: []",
      "createdAt: 2026-05-15T10:00:00Z",
      "updatedAt: 2026-05-15T10:00:00Z",
      "---",
      "",
      "Body.",
      "",
    ].join("\n");
    const filePath = await seedRaw(primary, "custom-fields", before);

    const repo = new FileSystemKnowledgeArticleRepository(primary);
    const result = await repo.update("k-min-diff-3", { tags: ["alpha", "beta", "gamma"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = await fs.readFile(filePath, "utf-8");
    const afterLines = after.split("\n");

    // Custom field line is byte-identical AND still in its original position (5).
    expect(afterLines[5]).toBe("replicability_score: 0.85");
    // Only tags (6) and updatedAt (10) changed.
    expect(differingLineIndices(before, after)).toEqual([6, 10]);

    // And it survives a fresh read back into the domain model.
    const reread = await repo.findById("k-min-diff-3");
    expect(reread.ok).toBe(true);
    if (!reread.ok) return;
    expect(reread.value.extraFrontmatter?.replicability_score).toBe(0.85);
  });
});
