import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { agentId, slug, timestamp } from "../../../src/core/types.js";
import { StructureService } from "../../../src/structure/service.js";

async function makeService() {
  const repoPath = path.join("/tmp", `monsthera-staleness-${randomUUID()}`);
  await fs.mkdir(repoPath, { recursive: true });
  const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const workRepo = new InMemoryWorkArticleRepository();
  const service = new StructureService({
    knowledgeRepo,
    workRepo,
    repoPath,
    logger: createLogger({ level: "error", domain: "test" }),
  });
  return { service, knowledgeRepo, workRepo, repoPath };
}

/** ISO timestamp `n` days in the past. */
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

describe("StructureService.buildStalenessReport", () => {
  it("returns an empty report for an empty corpus", async () => {
    const { service } = await makeService();
    const result = await service.buildStalenessReport();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.staleArticles).toEqual([]);
    expect(result.value.staleCodeRefs).toEqual([]);
    expect(result.value.sourceNewer).toEqual([]);
    expect(result.value.summary).toEqual({
      knowledgeScanned: 0,
      workScanned: 0,
      staleArticleCount: 0,
      staleCodeRefCount: 0,
      sourceNewerCount: 0,
    });
  });

  it("flags a knowledge article past the 45-day window and excludes a fresh one", async () => {
    const { service, knowledgeRepo } = await makeService();
    await knowledgeRepo.create({
      title: "Ancient",
      slug: slug("ancient"),
      category: "context",
      content: "old body",
      updatedAt: daysAgo(120),
      createdAt: daysAgo(120),
    });
    await knowledgeRepo.create({
      title: "Recent",
      slug: slug("recent"),
      category: "context",
      content: "new body",
    }); // updatedAt defaults to now → fresh

    const result = await service.buildStalenessReport();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const titles = result.value.staleArticles.map((a) => a.title);
    expect(titles).toContain("Ancient");
    expect(titles).not.toContain("Recent");

    const ancient = result.value.staleArticles.find((a) => a.title === "Ancient");
    expect(ancient?.type).toBe("knowledge");
    expect(ancient?.ageDays).toBeGreaterThanOrEqual(119);
    expect(result.value.summary.knowledgeScanned).toBe(2);
  });

  it("flags a stale work article by age", async () => {
    const { service, workRepo } = await makeService();
    await workRepo.create({
      title: "Old Work",
      template: "feature",
      priority: "medium",
      author: agentId("agent-1"),
      content: "## Objective\nship it\n## Acceptance Criteria\ndone",
      updatedAt: timestamp(daysAgo(90)),
      createdAt: timestamp(daysAgo(90)),
    });

    const result = await service.buildStalenessReport();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const work = result.value.staleArticles.find((a) => a.type === "work");
    expect(work?.title).toBe("Old Work");
    expect(result.value.summary.workScanned).toBe(1);
  });

  it("flags codeRefs that no longer resolve and ignores valid ones", async () => {
    const { service, knowledgeRepo, repoPath } = await makeService();
    await fs.writeFile(path.join(repoPath, "real-file.ts"), "export const x = 1;\n");
    await knowledgeRepo.create({
      title: "Refs",
      slug: slug("refs"),
      category: "context",
      content: "body", // fresh — exercises code-ref signal independently of age
      codeRefs: ["real-file.ts", "src/does/not/exist-xyz.ts"],
    });

    const result = await service.buildStalenessReport();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const refs = result.value.staleCodeRefs.map((r) => r.codeRef);
    expect(refs).toContain("src/does/not/exist-xyz.ts");
    expect(refs).not.toContain("real-file.ts");
    // fresh article → its broken ref is reported but the article itself is not stale
    expect(result.value.staleArticles).toEqual([]);
    expect(result.value.staleCodeRefs[0]?.type).toBe("knowledge");
  });

  it("flags knowledge whose imported source is newer than the article", async () => {
    const { service, knowledgeRepo, repoPath } = await makeService();
    const sourceRel = "imported-source.md";
    await fs.writeFile(path.join(repoPath, sourceRel), "# Imported\nfresh source body\n");
    await knowledgeRepo.create({
      title: "Imported Note",
      slug: slug("imported-note"),
      category: "context",
      content: "stale body",
      sourcePath: sourceRel,
      updatedAt: daysAgo(1), // young by age, but the source file (written just now) is newer
      createdAt: daysAgo(1),
    });

    const result = await service.buildStalenessReport();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const entry = result.value.sourceNewer.find((s) => s.title === "Imported Note");
    expect(entry).toBeDefined();
    expect(entry?.sourcePath).toBe(sourceRel);
    // source-newer also drives the article's freshness to stale
    expect(result.value.staleArticles.map((a) => a.title)).toContain("Imported Note");
    expect(result.value.summary.sourceNewerCount).toBe(1);
  });

  it("sorts stale articles most-stale-first", async () => {
    const { service, knowledgeRepo } = await makeService();
    await knowledgeRepo.create({
      title: "Older",
      slug: slug("older"),
      category: "context",
      content: "x",
      updatedAt: daysAgo(200),
      createdAt: daysAgo(200),
    });
    await knowledgeRepo.create({
      title: "Newer-stale",
      slug: slug("newer-stale"),
      category: "context",
      content: "x",
      updatedAt: daysAgo(50),
      createdAt: daysAgo(50),
    });

    const result = await service.buildStalenessReport();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.staleArticles.map((a) => a.title)).toEqual(["Older", "Newer-stale"]);
  });
});
