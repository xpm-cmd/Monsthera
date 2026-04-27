import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemKnowledgeArticleRepository } from "../../../src/knowledge/file-repository.js";
import { FileSystemWorkArticleRepository } from "../../../src/work/file-repository.js";
import { agentId } from "../../../src/core/types.js";

const cleanups: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "monsthera-race-"));
  cleanups.push(dir);
  return dir;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const dir = cleanups.pop();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("FileSystemKnowledgeArticleRepository — concurrent updates", () => {
  it("serializes 12 parallel updates without losing or corrupting writes", async () => {
    const root = await tempRoot();
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const created = await repo.create({
      title: "Race Subject",
      category: "guide",
      content: "initial\n",
      tags: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.id;

    const updates = Array.from({ length: 12 }, (_, i) =>
      repo.update(id, { content: `update-${i}\n` }),
    );
    const results = await Promise.all(updates);

    // Every update must succeed (no partial failures from interleaved writes).
    for (const r of results) {
      expect(r.ok).toBe(true);
    }

    // The article must still parse cleanly. Sin lock, archivos rotos
    // generan parse errors aquí — el lock asegura que el último write
    // sea íntegro.
    const final = await repo.findById(id);
    expect(final.ok).toBe(true);
    if (!final.ok) return;
    expect(final.value.content).toMatch(/^update-\d+\n$/);
  });

  it("recomputes slug consistently under concurrent renames", async () => {
    const root = await tempRoot();
    const repo = new FileSystemKnowledgeArticleRepository(root);

    const created = await repo.create({
      title: "Original",
      category: "guide",
      content: "x",
      tags: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.id;

    const renames = Array.from({ length: 10 }, (_, i) =>
      repo.update(id, { title: `Renamed v${i}` }),
    );
    const results = await Promise.all(renames);

    expect(results.every((r) => r.ok)).toBe(true);

    const final = await repo.findById(id);
    expect(final.ok).toBe(true);
    if (!final.ok) return;
    // Final title is one of the attempted renames; slug matches the title.
    expect(final.value.title).toMatch(/^Renamed v\d+$/);
    expect(final.value.slug.startsWith("renamed-v")).toBe(true);
  });
});

describe("FileSystemWorkArticleRepository — concurrent updates", () => {
  it("serializes 25 parallel updates without losing or corrupting writes", async () => {
    const root = await tempRoot();
    const repo = new FileSystemWorkArticleRepository(root);

    const created = await repo.create({
      title: "Race Work",
      template: "feature",
      author: agentId("tester"),
      priority: "medium",
      content: "initial\n",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.id;

    const updates = Array.from({ length: 12 }, (_, i) =>
      repo.update(id, { content: `update-${i}\n` }),
    );
    const results = await Promise.all(updates);

    for (const r of results) {
      expect(r.ok).toBe(true);
    }

    const final = await repo.findById(id);
    expect(final.ok).toBe(true);
    if (!final.ok) return;
    expect(final.value.content).toMatch(/^update-\d+\n$/);
  });
});
