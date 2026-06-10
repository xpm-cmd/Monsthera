import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { ok } from "../../../src/core/result.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { slug } from "../../../src/core/types.js";
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
    const { knowledgeRepo, service } = makeService();
    const created = await knowledgeRepo.create({
      title: "Dangling cross-ref",
      slug: slug("dangling-cross-ref"),
      category: "context",
      content: "See the handoff k-real-but-absent for the rest of the story.",
      tags: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const orphans = await service.getOrphanCitations();
    expect(orphans.ok).toBe(true);
    if (!orphans.ok) return;
    expect(orphans.value).toHaveLength(1);
    expect(orphans.value[0]?.sourceArticleId).toBe(created.value.id);
    expect(orphans.value[0]?.missingRefId).toBe("k-real-but-absent");
  });

  it("URL exemption does not suppress a real missing id sharing the same article", async () => {
    const { knowledgeRepo, service } = makeService();
    const created = await knowledgeRepo.create({
      title: "Mixed refs",
      slug: slug("mixed-refs"),
      category: "research",
      content: "Cross-ref to w-also-absent in prose.",
      tags: [],
      references: ["https://example.com/spec"],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const orphans = await service.getOrphanCitations();
    expect(orphans.ok).toBe(true);
    if (!orphans.ok) return;
    expect(orphans.value).toHaveLength(1);
    expect(orphans.value[0]?.missingRefId).toBe("w-also-absent");
  });

  it("uses the article's real filePath for sourcePath when the repository provides it (P0-B)", async () => {
    const { knowledgeRepo, service } = makeService();
    const created = await knowledgeRepo.create({
      title: "Dangling from id-named file",
      slug: slug("dangling-id-named"),
      category: "context",
      content: "See the handoff k-real-but-absent for the rest of the story.",
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
