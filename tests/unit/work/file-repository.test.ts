import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { FileSystemWorkArticleRepository } from "../../../src/work/file-repository.js";
import { Priority, WorkTemplate, WorkPhase, agentId } from "../../../src/core/types.js";

function createRepoRoot(): string {
  return `/tmp/monsthera-work-file-test-${randomUUID()}`;
}

describe("FileSystemWorkArticleRepository", () => {
  it("creates template-backed initial content when content is omitted", async () => {
    const repo = new FileSystemWorkArticleRepository(createRepoRoot());

    const result = await repo.create({
      title: "Filesystem article",
      template: WorkTemplate.FEATURE,
      priority: Priority.MEDIUM,
      author: agentId("agent-fs"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain("## Objective");
    expect(result.value.content).toContain("## Acceptance Criteria");
  });

  it("reopens persisted phase, dependencies, and review metadata from markdown", async () => {
    const repoRoot = createRepoRoot();
    const repo = new FileSystemWorkArticleRepository(repoRoot);

    const blocker = await repo.create({
      title: "Blocker",
      template: WorkTemplate.SPIKE,
      priority: Priority.MEDIUM,
      author: agentId("agent-1"),
      content: "## Objective\n\nInvestigate\n\n## Research Questions\n\n- Why?",
    });
    const article = await repo.create({
      title: "Main work",
      template: WorkTemplate.FEATURE,
      priority: Priority.HIGH,
      author: agentId("agent-2"),
      content: "## Objective\n\nShip it\n\n## Acceptance Criteria\n\n- Works",
    });

    expect(blocker.ok && article.ok).toBe(true);
    if (!blocker.ok || !article.ok) return;

    await repo.addDependency(article.value.id, blocker.value.id);
    await repo.advancePhase(article.value.id, WorkPhase.ENRICHMENT);
    await repo.assignReviewer(article.value.id, agentId("reviewer-1"));

    const reopened = new FileSystemWorkArticleRepository(repoRoot);
    const reloaded = await reopened.findById(article.value.id);

    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value.phase).toBe(WorkPhase.ENRICHMENT);
    expect(reloaded.value.blockedBy).toContain(blocker.value.id);
    expect(reloaded.value.dependencies).toContain(blocker.value.id);
    expect(reloaded.value.reviewers[0]?.agentId).toBe("reviewer-1");
    expect(reloaded.value.phaseHistory).toHaveLength(2);
  });
});
