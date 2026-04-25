import { describe, it, expect } from "vitest";
import { OrchestrationService } from "../../src/orchestration/service.js";
import { AgentDispatcher } from "../../src/orchestration/agent-dispatcher.js";
import { InMemoryWorkArticleRepository } from "../../src/work/in-memory-repository.js";
import { InMemoryKnowledgeArticleRepository } from "../../src/knowledge/in-memory-repository.js";
import { InMemoryOrchestrationEventRepository } from "../../src/orchestration/in-memory-repository.js";
import { PolicyLoader, POLICY_CATEGORY } from "../../src/work/policy-loader.js";
import { createLogger } from "../../src/core/logger.js";
import {
  WorkPhase,
  WorkTemplate,
  Priority,
  agentId,
  articleId,
  workId,
} from "../../src/core/types.js";

/**
 * End-to-end: a policy authored as a knowledge article gates a work
 * article. When `executeWave` runs, the dispatcher emits exactly one
 * `agent_needed` per missing role with `triggeredBy.policySlug` set, and a
 * second `executeWave` does NOT re-emit thanks to dedup. This is the
 * primary integration contract for ADR-008.
 */
describe("policy-driven dispatch (integration)", () => {
  async function setup() {
    const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
    const workRepo = new InMemoryWorkArticleRepository();
    const eventRepo = new InMemoryOrchestrationEventRepository();
    const logger = createLogger({ level: "error", domain: "test" });
    const policyLoader = new PolicyLoader({ knowledgeRepo, logger });
    const dispatcher = new AgentDispatcher({
      workRepo,
      eventRepo,
      logger,
      policyLoader,
      dedupWindowMs: 60 * 60 * 1000,
    });
    const service = new OrchestrationService({
      workRepo,
      orchestrationRepo: eventRepo,
      logger,
      policyLoader,
      agentDispatcher: dispatcher,
    });
    return { knowledgeRepo, workRepo, eventRepo, service };
  }

  it("emits agent_needed with the triggering policy slug; second wave dedupes", async () => {
    const { knowledgeRepo, workRepo, eventRepo, service } = await setup();

    // Author a policy via the knowledge base — no TS edit (ADR-007).
    const policyResult = await knowledgeRepo.create({
      id: articleId("k-policy-security"),
      title: "Policy: features touching auth require security enrichment",
      slug: "policy-feature-auth-security" as never,
      category: POLICY_CATEGORY,
      content: "Auth crosses a trust boundary; security reviews before implementation.",
      extraFrontmatter: {
        policy_applies_templates: ["feature"],
        policy_phase_transition: "enrichment->implementation",
        policy_content_matches: ["(?i)auth|oauth|session|token"],
        policy_requires_roles: ["security"],
        policy_requires_articles: [],
        policy_rationale: "Compliance requires a security signoff on auth surfaces.",
      },
    });
    if (!policyResult.ok) throw new Error(policyResult.error.message);

    // Feature work article whose content matches the policy regex.
    const created = await workRepo.create({
      title: "Add OAuth login",
      template: WorkTemplate.FEATURE,
      priority: Priority.HIGH,
      author: agentId("author"),
      content: "## Objective\n\nAdd OAuth login.\n\n## Acceptance Criteria\n\n- Works",
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("arch-agent"), status: "contributed" },
        { role: "security", agentId: agentId("sec-agent"), status: "pending" },
      ],
    });
    if (!created.ok) throw new Error(created.error.message);
    const advanced = await workRepo.advancePhase(created.value.id, WorkPhase.ENRICHMENT);
    if (!advanced.ok) throw new Error(advanced.error.message);
    const article = advanced.value;

    // First wave — must surface the failure as an agent_needed event.
    const plan1 = await service.planWave();
    if (!plan1.ok) throw new Error(plan1.error.message);
    expect(plan1.value.guardFailures.length).toBeGreaterThan(0);
    const failure = plan1.value.guardFailures.find((f) => f.workId === article.id);
    expect(failure).toBeDefined();

    const exec1 = await service.executeWave(plan1.value);
    if (!exec1.ok) throw new Error(exec1.error.message);

    expect(exec1.value.dispatched).toHaveLength(1);
    expect(exec1.value.dispatched[0]!.role).toBe("security");
    expect(exec1.value.dispatched[0]!.reason).toBe("policy");
    expect(exec1.value.dispatched[0]!.triggeredBy.policySlug).toBe("policy-feature-auth-security");
    expect(exec1.value.dispatched[0]!.deduped).toBe(false);

    const eventsAfter1 = await eventRepo.findByWorkId(workId(article.id));
    if (!eventsAfter1.ok) throw new Error(eventsAfter1.error.message);
    const needed1 = eventsAfter1.value.filter((e) => e.eventType === "agent_needed");
    expect(needed1).toHaveLength(1);
    const details = needed1[0]!.details as Record<string, unknown>;
    expect((details.triggeredBy as Record<string, unknown>).policySlug).toBe(
      "policy-feature-auth-security",
    );
    expect(details.reason).toBe("policy");

    // Second wave — same state, dispatcher must dedupe.
    const plan2 = await service.planWave();
    if (!plan2.ok) throw new Error(plan2.error.message);
    const exec2 = await service.executeWave(plan2.value);
    if (!exec2.ok) throw new Error(exec2.error.message);

    expect(exec2.value.dispatched).toHaveLength(1);
    expect(exec2.value.dispatched[0]!.deduped).toBe(true);

    const eventsAfter2 = await eventRepo.findByType("agent_needed");
    if (!eventsAfter2.ok) throw new Error(eventsAfter2.error.message);
    expect(eventsAfter2.value).toHaveLength(1);
  });
});
