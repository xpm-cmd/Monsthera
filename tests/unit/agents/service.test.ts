import { describe, it, expect } from "vitest";
import { createLogger } from "../../../src/core/logger.js";
import { agentId, timestamp, WorkPhase } from "../../../src/core/types.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { InMemoryOrchestrationEventRepository } from "../../../src/orchestration/in-memory-repository.js";
import { AgentService } from "../../../src/agents/service.js";

function createSilentLogger() {
  return createLogger({ level: "error", output: () => {} });
}

describe("AgentService", () => {
  it("derives agent profiles, touchpoints, and recent events from work", async () => {
    const workRepo = new InMemoryWorkArticleRepository();
    const orchestrationRepo = new InMemoryOrchestrationEventRepository();
    const service = new AgentService({
      workRepo,
      orchestrationRepo,
      logger: createSilentLogger(),
    });

    const reviewArticle = await workRepo.create({
      title: "Review API",
      template: "feature",
      phase: WorkPhase.REVIEW,
      priority: "high",
      author: agentId("agent-author"),
      lead: agentId("agent-lead"),
      assignee: agentId("agent-impl"),
      reviewers: [{ agentId: agentId("agent-reviewer"), status: "pending" }],
      enrichmentRoles: [{ role: "security", agentId: agentId("agent-security"), status: "pending" }],
      content: "## Objective\nReview API",
      createdAt: timestamp("2026-04-09T09:00:00.000Z"),
      updatedAt: timestamp("2026-04-09T10:00:00.000Z"),
    });
    expect(reviewArticle.ok).toBe(true);
    if (!reviewArticle.ok) return;

    const doneArticle = await workRepo.create({
      title: "Shipped docs",
      template: "bugfix",
      phase: WorkPhase.DONE,
      priority: "low",
      author: agentId("agent-author"),
      assignee: agentId("agent-docs"),
      enrichmentRoles: [],
      content: "## Objective\nDocs",
      createdAt: timestamp("2026-04-08T09:00:00.000Z"),
      updatedAt: timestamp("2026-04-08T10:00:00.000Z"),
    });
    expect(doneArticle.ok).toBe(true);
    if (!doneArticle.ok) return;

    const event = await orchestrationRepo.logEvent({
      workId: reviewArticle.value.id,
      eventType: "agent_spawned",
      agentId: agentId("agent-reviewer"),
      details: { lane: "review" },
    });
    expect(event.ok).toBe(true);

    const result = await service.listAgents();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.summary.totalAgents).toBe(6);
    expect(result.value.summary.activeAgents).toBe(5);
    expect(result.value.summary.reviewAgents).toBe(1);
    expect(result.value.summary.enrichmentAgents).toBe(1);

    const reviewer = result.value.agents.find((agent) => agent.id === "agent-reviewer");
    expect(reviewer).toBeDefined();
    expect(reviewer?.pendingReviewCount).toBe(1);
    expect(reviewer?.current?.phase).toBe("review");
    expect(reviewer?.recentEvents.some((recentEvent) => recentEvent.direct && recentEvent.eventType === "agent_spawned")).toBe(true);

    const author = result.value.agents.find((agent) => agent.id === "agent-author");
    expect(author).toBeDefined();
    expect(author?.authoredCount).toBe(2);
    expect(author?.workCount).toBe(2);
    expect(author?.status).toBe("active");

    const docsAgent = result.value.agents.find((agent) => agent.id === "agent-docs");
    expect(docsAgent).toBeDefined();
    expect(docsAgent?.status).toBe("idle");
    expect(docsAgent?.current?.phase).toBe("done");
  });

  it("returns not found for an unknown agent", async () => {
    const service = new AgentService({
      workRepo: new InMemoryWorkArticleRepository(),
      orchestrationRepo: new InMemoryOrchestrationEventRepository(),
      logger: createSilentLogger(),
    });

    const result = await service.getAgent("missing-agent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("NotFoundError");
    }
  });
});
