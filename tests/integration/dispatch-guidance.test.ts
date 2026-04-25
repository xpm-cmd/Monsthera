import { describe, it, expect } from "vitest";
import { AgentDispatcher } from "../../src/orchestration/agent-dispatcher.js";
import { InMemoryWorkArticleRepository } from "../../src/work/in-memory-repository.js";
import { InMemoryOrchestrationEventRepository } from "../../src/orchestration/in-memory-repository.js";
import { createLogger } from "../../src/core/logger.js";
import { WorkPhase, WorkTemplate, Priority, agentId, workId } from "../../src/core/types.js";
import type { GuardFailure } from "../../src/orchestration/types.js";

/**
 * Per ADR-008 §1.1, every `agent_needed` event must carry a guidance[]
 * array with three elements in order:
 *   1. context-pack pointer
 *   2. safe-parallel-dispatch invariant (cd && pwd OR --assert-worktree)
 *   3. role-phrasing for the agent
 *
 * This test exercises both branches of the cd line — explicit
 * `worktreePath` (bake the path in) and absent (use the placeholder +
 * --assert-worktree alternative).
 */
describe("dispatch guidance contract (ADR-008 §1.1)", () => {
  async function setup(opts?: { worktreePath?: string }) {
    const workRepo = new InMemoryWorkArticleRepository();
    const eventRepo = new InMemoryOrchestrationEventRepository();
    const logger = createLogger({ level: "error", domain: "test" });
    const dispatcher = new AgentDispatcher({
      workRepo,
      eventRepo,
      logger,
      ...(opts?.worktreePath !== undefined ? { worktreePath: opts.worktreePath } : {}),
    });
    const created = await workRepo.create({
      title: "Guidance test",
      template: WorkTemplate.FEATURE,
      priority: Priority.MEDIUM,
      author: agentId("author"),
      content: "## Objective\nDo it.\n\n## Acceptance Criteria\nWorks.",
      enrichmentRoles: [{ role: "architecture", agentId: agentId("arch"), status: "pending" }],
      references: ["k-related-1", "k-related-2"],
      codeRefs: ["src/foo.ts:10"],
    });
    if (!created.ok) throw new Error(created.error.message);
    const advanced = await workRepo.advancePhase(created.value.id, WorkPhase.ENRICHMENT);
    if (!advanced.ok) throw new Error(advanced.error.message);
    return { workRepo, eventRepo, dispatcher, article: advanced.value };
  }

  function makeFailure(article: { id: string }): GuardFailure {
    return {
      workId: article.id,
      transition: { from: WorkPhase.ENRICHMENT, to: WorkPhase.IMPLEMENTATION },
      failed: [{ name: "min_enrichment_met", passed: false }],
    };
  }

  async function readGuidance(
    eventRepo: InMemoryOrchestrationEventRepository,
    articleId: string,
  ) {
    const events = await eventRepo.findByWorkId(workId(articleId));
    if (!events.ok) throw new Error(events.error.message);
    const needed = events.value.find((e) => e.eventType === "agent_needed");
    expect(needed).toBeDefined();
    const details = needed!.details as Record<string, unknown>;
    const summary = details.contextPackSummary as Record<string, unknown>;
    return summary.guidance as string[];
  }

  it("includes the three required lines in order, in placeholder mode", async () => {
    const { eventRepo, dispatcher, article } = await setup();
    await dispatcher.dispatchFor([makeFailure(article)]);
    const guidance = await readGuidance(eventRepo, article.id);

    expect(guidance).toHaveLength(3);
    // 1. Context pack pointer
    expect(guidance[0]).toMatch(/^Read context pack: build_context_pack\(/);
    expect(guidance[0]).toContain(article.id);
    // 2. Safe-parallel-dispatch invariant — placeholder form
    expect(guidance[1]).toMatch(/^cd <target-worktree> && pwd/);
    expect(guidance[1]).toContain("safe-parallel-dispatch invariant from ADR-012");
    expect(guidance[1]).toContain("--assert-worktree");
    // 3. Role phrasing
    expect(guidance[2]).toBe(
      `Acting as architecture, contribute the architecture Perspective section to ${article.id}.`,
    );
  });

  it("bakes a literal cd <path> when worktreePath is provided", async () => {
    const { eventRepo, dispatcher, article } = await setup({
      worktreePath: "/tmp/worktrees/feature-x",
    });
    await dispatcher.dispatchFor([makeFailure(article)]);
    const guidance = await readGuidance(eventRepo, article.id);

    expect(guidance[1]).toBe(
      "cd /tmp/worktrees/feature-x && pwd # safe-parallel-dispatch invariant from ADR-012",
    );
    expect(guidance[1]).not.toContain("<target-worktree>");
    expect(guidance[1]).not.toContain("--assert-worktree");
  });

  it("forwards article.references and codeRefs into the slim summary", async () => {
    const { eventRepo, dispatcher, article } = await setup();
    await dispatcher.dispatchFor([makeFailure(article)]);
    const events = await eventRepo.findByWorkId(workId(article.id));
    if (!events.ok) throw new Error(events.error.message);
    const needed = events.value.find((e) => e.eventType === "agent_needed");
    const summary = (needed!.details as Record<string, unknown>).contextPackSummary as Record<
      string,
      unknown
    >;
    expect(summary.workArticleSlug).toBe(article.id);
    expect(summary.relatedKnowledgeSlugs).toEqual(["k-related-1", "k-related-2"]);
    expect(summary.codeRefs).toEqual(["src/foo.ts:10"]);
  });
});
