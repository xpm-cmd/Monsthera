import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { agentId, slug } from "../../../src/core/types.js";
import { StructureService } from "../../../src/structure/service.js";

describe("StructureService", () => {
  it("derives graph relationships and gap counts from knowledge, work, and code refs", async () => {
    const repoPath = path.join("/tmp", `monsthera-structure-${randomUUID()}`);
    await fs.mkdir(path.join(repoPath, "src"), { recursive: true });
    await fs.writeFile(path.join(repoPath, "src", "existing.ts"), "export const existing = true;\n", "utf-8");

    const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
    const workRepo = new InMemoryWorkArticleRepository();
    const logger = createLogger({ level: "error", domain: "test" });

    const knowledge = await knowledgeRepo.create({
      title: "Architecture Notes",
      slug: slug("architecture-notes"),
      category: "architecture",
      content: "Shared knowledge about the system.",
      tags: ["shared-tag"],
      codeRefs: ["src/existing.ts"],
    });
    expect(knowledge.ok).toBe(true);
    if (!knowledge.ok) return;

    const blocker = await workRepo.create({
      title: "Remove blocker",
      template: "bugfix",
      priority: "medium",
      author: agentId("agent-1"),
      tags: ["shared-tag"],
      content: "## Objective\nUnblock\n\n## Steps to Reproduce\n1. Repro\n\n## Acceptance Criteria\n- [ ] fixed",
    });
    expect(blocker.ok).toBe(true);
    if (!blocker.ok) return;

    const work = await workRepo.create({
      title: "Implement graph",
      template: "feature",
      priority: "high",
      author: agentId("agent-2"),
      tags: ["shared-tag"],
      references: [knowledge.value.id, "missing-knowledge"],
      dependencies: [blocker.value.id, "w-missing" as never],
      codeRefs: ["src/missing.ts"],
      content: "## Objective\nShip graph\n\n## Context\nGraph backend\n\n## Acceptance Criteria\n- [ ] graph\n\n## Scope\nlimited\n\n## Implementation\n/api/structure/graph",
    } as never);
    expect(work.ok).toBe(true);
    if (!work.ok) return;

    const service = new StructureService({
      knowledgeRepo,
      workRepo,
      repoPath,
      logger,
    });

    const result = await service.getGraph();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary.knowledgeCount).toBe(1);
    expect(result.value.summary.workCount).toBe(2);
    expect(result.value.summary.codeCount).toBe(2);
    expect(result.value.summary.missingReferenceCount).toBe(1);
    expect(result.value.summary.missingDependencyCount).toBe(1);
    expect(result.value.summary.missingCodeRefCount).toBe(1);
    expect(result.value.summary.sharedTagEdgeCount).toBe(3);

    expect(result.value.edges.some((edge) => edge.kind === "reference")).toBe(true);
    expect(result.value.edges.some((edge) => edge.kind === "dependency")).toBe(true);
    expect(result.value.edges.filter((edge) => edge.kind === "code_ref")).toHaveLength(2);

    const missingCodeNode = result.value.nodes.find((node) => node.kind === "code" && node.path === "src/missing.ts");
    expect(missingCodeNode?.exists).toBe(false);

    expect(result.value.gaps.missingReferences).toContain(`${work.value.id}:missing-knowledge`);
    expect(result.value.gaps.missingDependencies).toContain(`${work.value.id}:w-missing`);

    await fs.rm(repoPath, { recursive: true, force: true });
  });
});
