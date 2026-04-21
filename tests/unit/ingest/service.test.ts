import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { IngestService } from "../../../src/ingest/service.js";

function createSilentLogger() {
  return createLogger({ level: "error", output: () => {} });
}

describe("IngestService", () => {
  it("imports a markdown file into knowledge with sourcePath and code refs", async () => {
    const repoPath = path.join("/tmp", `monsthera-ingest-${randomUUID()}`);
    await fs.mkdir(path.join(repoPath, "docs"), { recursive: true });
    await fs.mkdir(path.join(repoPath, "src", "dashboard"), { recursive: true });
    await fs.writeFile(path.join(repoPath, "src", "dashboard", "index.ts"), "export {};\n", "utf-8");
    await fs.writeFile(
      path.join(repoPath, "docs", "guide.md"),
      "# Guide Title\n\nSee `src/dashboard/index.ts` for the entrypoint.\n",
      "utf-8",
    );

    const service = new IngestService({
      knowledgeRepo: new InMemoryKnowledgeArticleRepository(),
      repoPath,
      logger: createSilentLogger(),
    });

    const result = await service.importLocal({ sourcePath: "docs/guide.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.createdCount).toBe(1);
    expect(result.value.items[0]?.sourcePath).toBe("docs/guide.md");
    expect(result.value.items[0]?.codeRefCount).toBe(1);

    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("updates previously imported articles when sourcePath matches", async () => {
    const repoPath = path.join("/tmp", `monsthera-ingest-${randomUUID()}`);
    await fs.mkdir(path.join(repoPath, "docs"), { recursive: true });
    const sourcePath = path.join(repoPath, "docs", "architecture.md");
    await fs.writeFile(sourcePath, "# Architecture\n\nVersion one.\n", "utf-8");

    const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
    const service = new IngestService({
      knowledgeRepo,
      repoPath,
      logger: createSilentLogger(),
    });

    const first = await service.importLocal({ sourcePath: "docs/architecture.md" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    await fs.writeFile(sourcePath, "# Architecture\n\nVersion two.\n", "utf-8");
    const second = await service.importLocal({ sourcePath: "docs/architecture.md" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.createdCount).toBe(0);
    expect(second.value.updatedCount).toBe(1);

    const articles = await knowledgeRepo.findMany();
    expect(articles.ok).toBe(true);
    if (!articles.ok) return;
    expect(articles.value).toHaveLength(1);
    expect(articles.value[0]?.content).toContain("Version two.");

    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("can normalize imported content into a summary article", async () => {
    const repoPath = path.join("/tmp", `monsthera-ingest-${randomUUID()}`);
    await fs.mkdir(path.join(repoPath, "docs"), { recursive: true });
    await fs.mkdir(path.join(repoPath, "src", "search"), { recursive: true });
    await fs.writeFile(path.join(repoPath, "src", "search", "service.ts"), "export {};\n", "utf-8");
    await fs.writeFile(
      path.join(repoPath, "docs", "search-review.md"),
      [
        "# Search Review",
        "",
        "The current search pipeline mixes lexical ranking with semantic enrichment and needs a clearer explanation for operators.",
        "",
        "## Problems",
        "- Ranking behavior is difficult to inspect",
        "- Reindex timing is not documented",
        "",
        "See src/search/service.ts for the query lifecycle.",
      ].join("\n"),
      "utf-8",
    );

    const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
    const service = new IngestService({
      knowledgeRepo,
      repoPath,
      logger: createSilentLogger(),
    });

    const result = await service.importLocal({ sourcePath: "docs/search-review.md", mode: "summary" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.mode).toBe("summary");
    const articles = await knowledgeRepo.findMany();
    expect(articles.ok).toBe(true);
    if (!articles.ok) return;
    expect(articles.value).toHaveLength(1);
    expect(articles.value[0]?.content).toContain("## Summary");
    expect(articles.value[0]?.content).toContain("## Key points");
    expect(articles.value[0]?.content).toContain("## Code references");
    expect(articles.value[0]?.tags).toContain("summary");

    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("imports supported files recursively from a directory", async () => {
    const repoPath = path.join("/tmp", `monsthera-ingest-${randomUUID()}`);
    await fs.mkdir(path.join(repoPath, "docs", "nested"), { recursive: true });
    await fs.writeFile(path.join(repoPath, "docs", "one.md"), "# One\n\nBody\n", "utf-8");
    await fs.writeFile(path.join(repoPath, "docs", "nested", "two.txt"), "Two body\n", "utf-8");
    await fs.writeFile(path.join(repoPath, "docs", "nested", "ignore.json"), "{\"no\":true}\n", "utf-8");

    const service = new IngestService({
      knowledgeRepo: new InMemoryKnowledgeArticleRepository(),
      repoPath,
      logger: createSilentLogger(),
    });

    const result = await service.importLocal({ sourcePath: "docs", recursive: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.scannedFileCount).toBe(2);
    expect(result.value.importedCount).toBe(2);

    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("preserves frontmatter title when --category override is present", async () => {
    const repoPath = path.join("/tmp", `monsthera-ingest-${randomUUID()}`);
    await fs.mkdir(path.join(repoPath, "docs"), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, "docs", "titled.md"),
      [
        "---",
        'title: "Deliberate Title"',
        "tags: [foo]",
        "---",
        "## Not an H1",
        "",
        "Some body content.",
      ].join("\n"),
      "utf-8",
    );

    const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
    const service = new IngestService({
      knowledgeRepo,
      repoPath,
      logger: createSilentLogger(),
    });

    const result = await service.importLocal({
      sourcePath: "docs/titled.md",
      category: "context",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const articles = await knowledgeRepo.findMany();
    expect(articles.ok).toBe(true);
    if (!articles.ok) return;

    expect(articles.value).toHaveLength(1);
    expect(articles.value[0]?.title).toBe("Deliberate Title");
    expect(articles.value[0]?.category).toBe("context");

    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("returns not found for a missing source path", async () => {
    const repoPath = path.join("/tmp", `monsthera-ingest-${randomUUID()}`);
    await fs.mkdir(repoPath, { recursive: true });

    const service = new IngestService({
      knowledgeRepo: new InMemoryKnowledgeArticleRepository(),
      repoPath,
      logger: createSilentLogger(),
    });

    const result = await service.importLocal({ sourcePath: "docs/missing.md" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("NotFoundError");
    }

    await fs.rm(repoPath, { recursive: true, force: true });
  });
});
