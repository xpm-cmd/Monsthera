import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { FileSystemKnowledgeArticleRepository } from "../../../src/knowledge/file-repository.js";

/**
 * H1 — stat-cached read path.
 *
 * The repository caches parsed articles in-process and revalidates with a
 * stat sweep per operation. These tests pin the two sides of that deal:
 * the cache must actually avoid re-reading unchanged files (the point of
 * H1), and it must NEVER win over the filesystem — external writers (the
 * CLI next to the MCP server, Option-A corpora dropping files straight
 * into notes/) and own writes must always be visible on the next read.
 */

const readFileCalls: string[] = [];

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      readFileCalls.push(String(args[0]));
      return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as typeof actual.readFile,
  };
});

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-k-cache-"));
  readFileCalls.length = 0;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function articleRaw(id: string, slugValue: string, body: string, tags: string[] = []): string {
  return [
    "---",
    `id: ${id}`,
    `title: Title ${id}`,
    `slug: ${slugValue}`,
    "category: context",
    `tags: [${tags.join(", ")}]`,
    "codeRefs: []",
    "references: []",
    "createdAt: 2026-06-01T00:00:00.000Z",
    "updatedAt: 2026-06-01T00:00:00.000Z",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

async function seed(slugValue: string, raw: string): Promise<string> {
  const notesDir = path.join(root, "notes");
  await fs.mkdir(notesDir, { recursive: true });
  const filePath = path.join(notesDir, `${slugValue}.md`);
  await fs.writeFile(filePath, raw, "utf-8");
  return filePath;
}

/** Age a file's mtime out of the cache's racy window so hits are trusted. */
async function ageFile(filePath: string): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(filePath, past, past);
}

function notesReads(): string[] {
  return readFileCalls.filter((p) => p.includes(path.join(root, "notes")));
}

describe("stat-cached reads (H1)", () => {
  it("repeated reads of an unchanged corpus do not re-read files", async () => {
    const a = await seed("alpha", articleRaw("k-aaaa0001", "alpha", "Alpha body"));
    const b = await seed("beta", articleRaw("k-bbbb0002", "beta", "Beta body"));
    await ageFile(a);
    await ageFile(b);
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const first = await repo.findMany();
    expect(first.ok).toBe(true);
    const afterFirst = notesReads().length;
    expect(afterFirst).toBe(2);

    const second = await repo.findMany();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value).toHaveLength(2);
    expect(notesReads().length).toBe(afterFirst);
  });

  it("a file dropped into notes/ after a read is visible on the next read (Option-A drop-in)", async () => {
    await seed("alpha", articleRaw("k-aaaa0001", "alpha", "Alpha body"));
    const repo = new FileSystemKnowledgeArticleRepository(root);

    await repo.findMany();
    await seed("dropped", articleRaw("k-dddd0004", "dropped", "Dropped in externally"));
    const second = await repo.findMany();

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.map((article) => article.slug).sort()).toEqual(["alpha", "dropped"]);
  });

  it("an external in-place rewrite is visible on the next read", async () => {
    const filePath = await seed("alpha", articleRaw("k-aaaa0001", "alpha", "Original body"));
    await ageFile(filePath);
    const repo = new FileSystemKnowledgeArticleRepository(root);

    await repo.findMany();
    await fs.writeFile(filePath, articleRaw("k-aaaa0001", "alpha", "Rewritten externally"), "utf-8");
    const after = await repo.findById("k-aaaa0001");

    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.content.trim()).toBe("Rewritten externally");
  });

  it("an externally deleted file disappears from reads (no phantoms)", async () => {
    const a = await seed("alpha", articleRaw("k-aaaa0001", "alpha", "Alpha body"));
    await seed("beta", articleRaw("k-bbbb0002", "beta", "Beta body"));
    const repo = new FileSystemKnowledgeArticleRepository(root);

    await repo.findMany();
    await fs.rm(a);
    const second = await repo.findMany();

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.map((article) => article.slug)).toEqual(["beta"]);
    const gone = await repo.findById("k-aaaa0001");
    expect(gone.ok).toBe(false);
  });

  it("an own update is visible on the immediately following read", async () => {
    const filePath = await seed("alpha", articleRaw("k-aaaa0001", "alpha", "Original body"));
    await ageFile(filePath);
    const repo = new FileSystemKnowledgeArticleRepository(root);

    await repo.findMany();
    const updated = await repo.update("k-aaaa0001", { content: "Updated through the repo" });
    expect(updated.ok).toBe(true);
    const after = await repo.findById("k-aaaa0001");

    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.content).toBe("Updated through the repo");
  });

  it("returns defensive copies — mutating a result does not poison later reads", async () => {
    const filePath = await seed("alpha", articleRaw("k-aaaa0001", "alpha", "Alpha body", ["original"]));
    await ageFile(filePath);
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const first = await repo.findById("k-aaaa0001");
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    (first.value.tags as string[]).push("injected");
    (first.value as { title: string }).title = "Hijacked";

    const second = await repo.findById("k-aaaa0001");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.tags).toEqual(["original"]);
    expect(second.value.title).toBe("Title k-aaaa0001");
  });
});
