import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { slug } from "../../../src/core/types.js";
import { StructureService } from "../../../src/structure/service.js";

async function makeService() {
  const repoPath = path.join("/tmp", `monsthera-verify-cited-${randomUUID()}`);
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

describe("StructureService.verifyCitedValues", () => {
  it("returns NotFound when the article does not exist", async () => {
    const { service } = await makeService();
    const result = await service.verifyCitedValues("k-missing");
    expect(result.ok).toBe(false);
  });

  it("reports a mismatch when the citation's claimed value is not in the cited article", async () => {
    const { service, knowledgeRepo } = await makeService();

    const target = await knowledgeRepo.create({
      title: "Cost Pins",
      slug: slug("cost-pins"),
      category: "context",
      content: "The canonical per-RT cost is $0.010/rt.",
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const source = await knowledgeRepo.create({
      title: "Source",
      slug: slug("source"),
      category: "context",
      content: `Reviewing ${target.value.id} — cost is $0.10/rt claimed here.`,
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    const result = await service.verifyCitedValues(source.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeGreaterThan(0);
    const finding = result.value.find((f) => f.claimedValue === "$0.10");
    expect(finding).toBeDefined();
    expect(finding?.sourceArticle).toBe(source.value.id);
    expect(finding?.citedArticle).toBe(target.value.id);
    expect(finding?.foundValues).toContain("$0.010");
  });

  it("passes when the cited article actually contains the claimed value", async () => {
    const { service, knowledgeRepo } = await makeService();

    const target = await knowledgeRepo.create({
      title: "Cost Pins",
      slug: slug("cost-pins"),
      category: "context",
      content: "Per-RT cost is $0.010/rt, canonical.",
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const source = await knowledgeRepo.create({
      title: "Source",
      slug: slug("source"),
      category: "context",
      content: `Reviewing ${target.value.id} — per-RT cost $0.010 is correct.`,
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    const result = await service.verifyCitedValues(source.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("normalises numeric tokens so $ and commas do not create false mismatches", async () => {
    const { service, knowledgeRepo } = await makeService();

    const target = await knowledgeRepo.create({
      title: "Floor",
      slug: slug("floor"),
      category: "context",
      content: "Floor $1,815 is the canonical figure.",
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const source = await knowledgeRepo.create({
      title: "Source",
      slug: slug("source"),
      category: "context",
      content: `See ${target.value.id} — 1,815 is the number.`,
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    const result = await service.verifyCitedValues(source.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("resolves [[slug]] wikilinks for citation-with-number pairs", async () => {
    const { service, knowledgeRepo } = await makeService();

    await knowledgeRepo.create({
      title: "Target",
      slug: slug("kill-switch-brief"),
      category: "context",
      content: "Boundary is 22.35 bars.",
    });

    const source = await knowledgeRepo.create({
      title: "Source",
      slug: slug("source"),
      category: "context",
      content: "Per [[kill-switch-brief]] the calibration showed 22.4 bars.",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    const result = await service.verifyCitedValues(source.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.some((f) => f.claimedValue === "22.4")).toBe(true);
  });

  it("ignores citation tokens that appear inside fenced code blocks", async () => {
    const { service, knowledgeRepo } = await makeService();

    const target = await knowledgeRepo.create({
      title: "Target",
      slug: slug("target"),
      category: "context",
      content: "Canonical value is $0.010.",
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    const source = await knowledgeRepo.create({
      title: "Source",
      slug: slug("source"),
      category: "context",
      content: [
        "Prose without citation here.",
        "",
        "```",
        `${target.value.id} $0.99 is only an example in a code block`,
        "```",
      ].join("\n"),
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    const result = await service.verifyCitedValues(source.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("does not emit findings for unknown citation targets (orphan is a separate rule)", async () => {
    const { service, knowledgeRepo } = await makeService();

    const source = await knowledgeRepo.create({
      title: "Source",
      slug: slug("source"),
      category: "context",
      content: "Citing k-does-not-exist 22.4 bars in prose.",
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;

    const result = await service.verifyCitedValues(source.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});
