import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { agentId, slug } from "../../../src/core/types.js";
import { StructureService } from "../../../src/structure/service.js";

async function makeService() {
  const repoPath = path.join("/tmp", `monsthera-refgraph-${randomUUID()}`);
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

describe("StructureService.getRefGraph", () => {
  it("returns NotFound when the article does not exist", async () => {
    const { service, repoPath } = await makeService();
    const result = await service.getRefGraph("k-missing");
    expect(result.ok).toBe(false);
    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("returns the full incoming and outgoing reference set for a knowledge article", async () => {
    const { service, knowledgeRepo, repoPath } = await makeService();

    const target = await knowledgeRepo.create({
      title: "Target",
      slug: slug("target"),
      category: "context",
      content: "I am the target.",
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    // One article cites target via explicit frontmatter reference.
    const citer1 = await knowledgeRepo.create({
      title: "Citer Via Frontmatter",
      slug: slug("citer-1"),
      category: "context",
      content: "I reference the target in frontmatter.",
      references: [target.value.id],
    });
    expect(citer1.ok).toBe(true);
    if (!citer1.ok) return;

    // Another article cites target via inline ID in prose.
    const citer2 = await knowledgeRepo.create({
      title: "Citer Via Inline",
      slug: slug("citer-2"),
      category: "context",
      content: `I inline-cite ${target.value.id} in prose.`,
    });
    expect(citer2.ok).toBe(true);
    if (!citer2.ok) return;

    // Target article references something else outgoing.
    const downstream = await knowledgeRepo.create({
      title: "Downstream",
      slug: slug("downstream"),
      category: "context",
      content: "Terminal article.",
    });
    expect(downstream.ok).toBe(true);
    if (!downstream.ok) return;

    await knowledgeRepo.update(target.value.id, {
      references: [downstream.value.id],
    });

    const result = await service.getRefGraph(target.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.incoming.map((e) => e.title).sort()).toEqual([
      "Citer Via Frontmatter",
      "Citer Via Inline",
    ]);
    expect(result.value.outgoing.map((e) => e.title)).toEqual(["Downstream"]);

    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("resolves by slug as well as by id", async () => {
    const { service, knowledgeRepo, repoPath } = await makeService();
    const art = await knowledgeRepo.create({
      title: "Slug Target",
      slug: slug("slug-target"),
      category: "context",
      content: "body",
    });
    expect(art.ok).toBe(true);
    if (!art.ok) return;

    const result = await service.getRefGraph("slug-target");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.articleId).toBe(art.value.id);

    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("does not include shared-tag, dependency, or code-ref edges", async () => {
    const { service, knowledgeRepo, workRepo, repoPath } = await makeService();

    const target = await knowledgeRepo.create({
      title: "Target",
      slug: slug("target"),
      category: "context",
      content: "",
      tags: ["shared"],
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    // Sibling has the same tag — should NOT appear in refgraph.
    await knowledgeRepo.create({
      title: "Sibling",
      slug: slug("sibling"),
      category: "context",
      content: "",
      tags: ["shared"],
    });

    // Work article cites target (this SHOULD appear as incoming).
    const work = await workRepo.create({
      title: "Work citing target",
      template: "feature",
      priority: "medium",
      author: agentId("agent-1"),
      references: [target.value.id],
      content:
        "## Objective\nship\n\n## Context\nc\n\n## Acceptance Criteria\n- [ ] a\n\n## Scope\ns\n\n## Implementation\ni",
    } as never);
    expect(work.ok).toBe(true);
    if (!work.ok) return;

    const result = await service.getRefGraph(target.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.incoming).toHaveLength(1);
    expect(result.value.incoming[0]?.title).toBe("Work citing target");
    expect(result.value.incoming[0]?.kind).toBe("work");
    expect(result.value.outgoing).toEqual([]);

    await fs.rm(repoPath, { recursive: true, force: true });
  });
});

describe("StructureService.getOrphanCitations", () => {
  it("returns [] when every citation resolves", async () => {
    const { service, knowledgeRepo, repoPath } = await makeService();
    const a = await knowledgeRepo.create({
      title: "A",
      slug: slug("a"),
      category: "context",
      content: "",
    });
    const b = await knowledgeRepo.create({
      title: "B",
      slug: slug("b"),
      category: "context",
      content: "",
      references: [a.ok ? a.value.id : "never"],
    });
    expect(a.ok && b.ok).toBe(true);

    const result = await service.getOrphanCitations();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);

    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("surfaces unresolved frontmatter references as orphans", async () => {
    const { service, knowledgeRepo, repoPath } = await makeService();
    const a = await knowledgeRepo.create({
      title: "A",
      slug: slug("a"),
      category: "context",
      content: "",
      references: ["k-does-not-exist"],
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const result = await service.getOrphanCitations();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.sourceArticleId).toBe(a.value.id);
    expect(result.value[0]?.missingRefId).toBe("k-does-not-exist");
    expect(result.value[0]?.sourcePath).toBe(path.join("notes", "a.md"));

    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("surfaces unresolved inline IDs in prose as orphans", async () => {
    const { service, knowledgeRepo, repoPath } = await makeService();
    const a = await knowledgeRepo.create({
      title: "A",
      slug: slug("a"),
      category: "context",
      content: "This prose cites k-nowhere directly.",
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    const result = await service.getOrphanCitations();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.map((o) => o.missingRefId)).toEqual(["k-nowhere"]);

    await fs.rm(repoPath, { recursive: true, force: true });
  });

  it("points to work-articles/<id>.md for work-article sources", async () => {
    const { service, workRepo, repoPath } = await makeService();
    const work = await workRepo.create({
      title: "Work",
      template: "feature",
      priority: "medium",
      author: agentId("agent-1"),
      references: ["k-ghost"],
      content:
        "## Objective\nship\n\n## Context\nc\n\n## Acceptance Criteria\n- [ ] a\n\n## Scope\ns\n\n## Implementation\ni",
    } as never);
    expect(work.ok).toBe(true);
    if (!work.ok) return;

    const result = await service.getOrphanCitations();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.sourcePath).toBe(
      path.join("work-articles", `${work.value.id}.md`),
    );

    await fs.rm(repoPath, { recursive: true, force: true });
  });
});
