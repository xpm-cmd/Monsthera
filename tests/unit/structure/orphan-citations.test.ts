import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { ok } from "../../../src/core/result.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { articleId, slug } from "../../../src/core/types.js";
import { StructureService } from "../../../src/structure/service.js";

/**
 * False-positive hardening for the `orphan_citation` signal (feat/p2-corpus-hygiene).
 *
 * Two classes of NON-orphan were leaking into `getGraph().gaps.missingReferences`
 * and thus into `getOrphanCitations()` (CLI `monsthera lint`, `monsthera knowledge
 * refs --orphans`, and the MCP `refs_orphans` tool all read it):
 *   (a) external URLs listed in frontmatter `references:`
 *   (b) example article ids inside a soft-wrapped (multi-line) inline-code span
 *
 * A genuinely-missing internal article id must STILL flag — that control guards
 * against over-exempting.
 */
function makeService() {
  const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const workRepo = new InMemoryWorkArticleRepository();
  const logger = createLogger({ level: "error", domain: "test" });
  // repoPath only needs to exist as a string; no codeRefs resolved in these cases.
  const repoPath = path.join("/tmp", `monsthera-orphan-${randomUUID()}`);
  const service = new StructureService({ knowledgeRepo, workRepo, repoPath, logger });
  return { knowledgeRepo, workRepo, service };
}

describe("getOrphanCitations — false-positive hardening", () => {
  it("does NOT flag external URL references as orphans (gitnexus regression)", async () => {
    const { knowledgeRepo, service } = makeService();
    const created = await knowledgeRepo.create({
      title: "GitNexus patterns",
      slug: slug("gitnexus-patterns"),
      category: "research",
      content: "External research note.",
      tags: [],
      references: [
        "https://github.com/abhigyanpatwari/GitNexus",
        "https://raw.githubusercontent.com/abhigyanpatwari/GitNexus/main/ARCHITECTURE.md",
      ],
    });
    expect(created.ok).toBe(true);

    const orphans = await service.getOrphanCitations();
    expect(orphans.ok).toBe(true);
    if (!orphans.ok) return;
    expect(orphans.value).toHaveLength(0);

    // And the graph summary must not be inflated by URLs either.
    const graph = await service.getGraph();
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(graph.value.summary.missingReferenceCount).toBe(0);
    expect(
      graph.value.gaps.missingReferences.some((e) => /https?:\/\//i.test(e)),
    ).toBe(false);
  });

  it("does NOT flag ids inside a soft-wrapped inline-code span (convoy-hardening regression)", async () => {
    const { knowledgeRepo, service } = makeService();
    const created = await knowledgeRepo.create({
      title: "Convoy hardening decisions",
      slug: slug("convoy-hardening-decisions"),
      category: "architecture",
      content: [
        "2. CLI ergonomics. `monsthera convoy create --lead w-x --members",
        "   w-a,w-b --goal 'g'` is the muscle-memory shape from S3.",
      ].join("\n"),
      tags: [],
    });
    expect(created.ok).toBe(true);

    const orphans = await service.getOrphanCitations();
    expect(orphans.ok).toBe(true);
    if (!orphans.ok) return;
    expect(orphans.value).toHaveLength(0);
  });

  it("STILL flags a genuinely-missing internal article id (control)", async () => {
    // Deliberately digit-bearing (`k-77-…`): the P0-C ID-shape rule no
    // longer extracts digit-less prose ids like the old `k-real-but-absent`.
    const { knowledgeRepo, service } = makeService();
    const created = await knowledgeRepo.create({
      title: "Dangling cross-ref",
      slug: slug("dangling-cross-ref"),
      category: "context",
      content: "See the handoff k-77-real-but-absent for the rest of the story.",
      tags: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const orphans = await service.getOrphanCitations();
    expect(orphans.ok).toBe(true);
    if (!orphans.ok) return;
    expect(orphans.value).toHaveLength(1);
    expect(orphans.value[0]?.sourceArticleId).toBe(created.value.id);
    expect(orphans.value[0]?.missingRefId).toBe("k-77-real-but-absent");
  });

  it("URL exemption does not suppress a real missing id sharing the same article", async () => {
    const { knowledgeRepo, service } = makeService();
    const created = await knowledgeRepo.create({
      title: "Mixed refs",
      slug: slug("mixed-refs"),
      category: "research",
      content: "Cross-ref to w-77-also-absent in prose.",
      tags: [],
      references: ["https://example.com/spec"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const orphans = await service.getOrphanCitations();
    expect(orphans.ok).toBe(true);
    if (!orphans.ok) return;
    expect(orphans.value).toHaveLength(1);
    expect(orphans.value[0]?.missingRefId).toBe("w-77-also-absent");
  });

  it("uses the article's real filePath for sourcePath when the repository provides it (P0-B)", async () => {
    const { knowledgeRepo, service } = makeService();
    const created = await knowledgeRepo.create({
      title: "Dangling from id-named file",
      slug: slug("dangling-id-named"),
      category: "context",
      content: "See the handoff k-77-real-but-absent for the rest of the story.",
      tags: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Simulate a file-backed view of an externally authored corpus: the
    // backing file is ID-named, so the repository decorates each article
    // with its real relative path at read time.
    const baseFindMany = knowledgeRepo.findMany.bind(knowledgeRepo);
    knowledgeRepo.findMany = async () => {
      const result = await baseFindMany();
      if (!result.ok) return result;
      return ok(result.value.map((a) => ({ ...a, filePath: `notes/k-99-${a.slug}.md` })));
    };

    const orphans = await service.getOrphanCitations();
    expect(orphans.ok).toBe(true);
    if (!orphans.ok) return;
    expect(orphans.value).toHaveLength(1);
    expect(orphans.value[0]?.sourcePath).toBe("notes/k-99-dangling-id-named.md");
  });
});

describe("getOrphanCitations — shorthand-stem prefix resolution (Banyan P0-C)", () => {
  /**
   * Externally authored corpora (Banyan) use FULL-length ids like
   * `k-10-01-picard-1976-maximal-closure…` while their prose cites the
   * shorthand stem (`k-10-01`). A reference that misses every exact id/slug
   * must ALSO resolve when at least one article id starts with `ref + "-"`.
   * Orphan ONLY when both exact and prefix matching fail.
   */
  async function makeStemFixture() {
    const ctx = makeService();
    const target = await ctx.knowledgeRepo.create({
      id: articleId("k-10-01-long-descriptive-slug"),
      title: "Long descriptive target",
      slug: slug("long-descriptive-slug"),
      category: "context",
      content: "Target body.",
      tags: [],
    });
    expect(target.ok).toBe(true);
    return ctx;
  }

  it("prose stem k-10-01 prefix-resolves to k-10-01-long-descriptive-slug → 0 orphans", async () => {
    const { knowledgeRepo, service } = await makeStemFixture();
    const citing = await knowledgeRepo.create({
      title: "Citing article",
      slug: slug("citing-article"),
      category: "context",
      content: "The proof in k-10-01 settles this.",
      tags: [],
    });
    expect(citing.ok).toBe(true);
    if (!citing.ok) return;

    const orphans = await service.getOrphanCitations();
    expect(orphans.ok).toBe(true);
    if (!orphans.ok) return;
    expect(orphans.value).toHaveLength(0);

    // The stem citation materialises as a real reference edge, so
    // refs incoming/outgoing see it too — not just orphan suppression.
    const graph = await service.getGraph();
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    expect(
      graph.value.edges.some(
        (e) =>
          e.kind === "reference" &&
          e.source === `k:${citing.value.id}` &&
          e.target === "k:k-10-01-long-descriptive-slug",
      ),
    ).toBe(true);
  });

  it("prose k-99-99-ghost with no exact or prefix match → 1 orphan", async () => {
    const { knowledgeRepo, service } = await makeStemFixture();
    const citing = await knowledgeRepo.create({
      title: "Ghost citer",
      slug: slug("ghost-citer"),
      category: "context",
      content: "Cites k-99-99-ghost for the control.",
      tags: [],
    });
    expect(citing.ok).toBe(true);
    if (!citing.ok) return;

    const orphans = await service.getOrphanCitations();
    expect(orphans.ok).toBe(true);
    if (!orphans.ok) return;
    expect(orphans.value).toHaveLength(1);
    expect(orphans.value[0]?.missingRefId).toBe("k-99-99-ghost");
  });

  it("prose k-10-0 does NOT prefix-resolve (hyphen boundary guard) → 1 orphan", async () => {
    const { knowledgeRepo, service } = await makeStemFixture();
    const citing = await knowledgeRepo.create({
      title: "Truncated citer",
      slug: slug("truncated-citer"),
      category: "context",
      content: "A sloppy mention of k-10-0 must stay an orphan.",
      tags: [],
    });
    expect(citing.ok).toBe(true);
    if (!citing.ok) return;

    const orphans = await service.getOrphanCitations();
    expect(orphans.ok).toBe(true);
    if (!orphans.ok) return;
    expect(orphans.value).toHaveLength(1);
    expect(orphans.value[0]?.missingRefId).toBe("k-10-0");
  });

  it("frontmatter reference k-10-01 also prefix-resolves → 0 orphans", async () => {
    const { knowledgeRepo, service } = await makeStemFixture();
    const citing = await knowledgeRepo.create({
      title: "Frontmatter citer",
      slug: slug("frontmatter-citer"),
      category: "context",
      content: "Body without inline citations.",
      tags: [],
      references: ["k-10-01"],
    });
    expect(citing.ok).toBe(true);
    if (!citing.ok) return;

    const orphans = await service.getOrphanCitations();
    expect(orphans.ok).toBe(true);
    if (!orphans.ok) return;
    expect(orphans.value).toHaveLength(0);
  });

  it("work-article prose stem k-10-01 prefix-resolves too (uniform rule)", async () => {
    const { workRepo, service } = await makeStemFixture();
    const work = await workRepo.create({
      title: "Work citer",
      template: "feature",
      priority: "medium",
      author: "agent-1",
      content:
        "## Objective\nUse k-10-01 result\n\n## Context\nc\n\n## Acceptance Criteria\n- [ ] a\n\n## Scope\ns\n\n## Implementation\ni",
    } as never);
    expect(work.ok).toBe(true);
    if (!work.ok) return;

    const orphans = await service.getOrphanCitations();
    expect(orphans.ok).toBe(true);
    if (!orphans.ok) return;
    expect(orphans.value).toHaveLength(0);
  });
});
