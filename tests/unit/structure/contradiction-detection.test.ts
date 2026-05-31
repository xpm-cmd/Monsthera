import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { slug } from "../../../src/core/types.js";
import { StructureService } from "../../../src/structure/service.js";
import type { CanonicalValue } from "../../../src/work/policy-loader.js";

async function makeService() {
  const repoPath = path.join("/tmp", `monsthera-contradiction-${randomUUID()}`);
  await fs.mkdir(repoPath, { recursive: true });
  const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const workRepo = new InMemoryWorkArticleRepository();
  const service = new StructureService({
    knowledgeRepo,
    workRepo,
    repoPath,
    logger: createLogger({ level: "error", domain: "test" }),
  });
  return { service, knowledgeRepo, workRepo };
}

// The registry supplies only the vocabulary of names worth checking; the
// comparison is article-vs-article, so the `value` here is not the arbiter.
const CV: readonly CanonicalValue[] = [{ name: "throughput", value: "100" }];

describe("StructureService.detectContradictions", () => {
  it("returns nothing when the canonical registry is empty", async () => {
    const { service, knowledgeRepo } = await makeService();
    await knowledgeRepo.create({ title: "A", slug: slug("a"), category: "context", content: "throughput is 100", tags: ["perf"] });
    await knowledgeRepo.create({ title: "B", slug: slug("b"), category: "context", content: "throughput is 200", tags: ["perf"] });
    const result = await service.detectContradictions([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("flags two tag-adjacent articles that state different values for a canonical name", async () => {
    const { service, knowledgeRepo } = await makeService();
    const a = await knowledgeRepo.create({ title: "A", slug: slug("a"), category: "context", content: "throughput is 100 rps here", tags: ["perf"] });
    const b = await knowledgeRepo.create({ title: "B", slug: slug("b"), category: "context", content: "throughput is 200 rps here", tags: ["perf"] });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const result = await service.detectContradictions(CV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);

    const finding = result.value[0]!;
    expect(finding.name).toBe("throughput");
    expect(finding.sharedVia).toBe("shared_tag");
    expect(finding.sharedKey).toBe("perf");
    expect([finding.articleA, finding.articleB].sort()).toEqual([a.value.id, b.value.id].sort());
    expect([finding.valueA, finding.valueB].sort()).toEqual(["100", "200"]);
    // ids are ordered so the pair surfaces once, deterministically
    expect(finding.articleA < finding.articleB).toBe(true);
  });

  it("flags code-ref-adjacent articles and reports sharedVia=code_ref", async () => {
    const { service, knowledgeRepo } = await makeService();
    await knowledgeRepo.create({ title: "A", slug: slug("a"), category: "context", content: "throughput is 100", codeRefs: ["src/engine.ts"] });
    await knowledgeRepo.create({ title: "B", slug: slug("b"), category: "context", content: "throughput is 200", codeRefs: ["src/engine.ts"] });
    const result = await service.detectContradictions(CV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]!.sharedVia).toBe("code_ref");
  });

  it("does NOT flag divergent values when the two articles are not graph-adjacent", async () => {
    const { service, knowledgeRepo } = await makeService();
    await knowledgeRepo.create({ title: "A", slug: slug("a"), category: "context", content: "throughput is 100", tags: ["perf"] });
    await knowledgeRepo.create({ title: "B", slug: slug("b"), category: "context", content: "throughput is 200", tags: ["unrelated"] });
    const result = await service.detectContradictions(CV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("does NOT flag adjacent articles that agree on the value", async () => {
    const { service, knowledgeRepo } = await makeService();
    await knowledgeRepo.create({ title: "A", slug: slug("a"), category: "context", content: "throughput is 100", tags: ["perf"] });
    await knowledgeRepo.create({ title: "B", slug: slug("b"), category: "context", content: "throughput is 100 confirmed", tags: ["perf"] });
    const result = await service.detectContradictions(CV);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("restricts findings to a single article when opts.articleId is given", async () => {
    const { service, knowledgeRepo } = await makeService();
    const a = await knowledgeRepo.create({ title: "A", slug: slug("a"), category: "context", content: "throughput is 100", tags: ["perf"] });
    await knowledgeRepo.create({ title: "B", slug: slug("b"), category: "context", content: "throughput is 200", tags: ["perf"] });
    const c = await knowledgeRepo.create({ title: "C", slug: slug("c"), category: "context", content: "no canonical mention", tags: ["other"] });
    expect(a.ok && c.ok).toBe(true);
    if (!a.ok || !c.ok) return;

    const involvingA = await service.detectContradictions(CV, { articleId: a.value.id });
    expect(involvingA.ok).toBe(true);
    if (!involvingA.ok) return;
    expect(involvingA.value).toHaveLength(1);

    const involvingC = await service.detectContradictions(CV, { articleId: "c" }); // by slug
    expect(involvingC.ok).toBe(true);
    if (!involvingC.ok) return;
    expect(involvingC.value).toEqual([]);
  });
});
