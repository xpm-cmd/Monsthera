import { describe, it, expect } from "vitest";
import { OrchestrationService } from "../../src/orchestration/service.js";
import { AgentDispatcher } from "../../src/orchestration/agent-dispatcher.js";
import { InMemoryWorkArticleRepository } from "../../src/work/in-memory-repository.js";
import { InMemoryKnowledgeArticleRepository } from "../../src/knowledge/in-memory-repository.js";
import { InMemoryOrchestrationEventRepository } from "../../src/orchestration/in-memory-repository.js";
import { PolicyLoader, POLICY_CATEGORY } from "../../src/work/policy-loader.js";
import { createLogger } from "../../src/core/logger.js";
import {
  Priority,
  WorkPhase,
  WorkTemplate,
  agentId,
  articleId,
} from "../../src/core/types.js";
import type { AgentNeededDetails } from "../../src/orchestration/types.js";

/**
 * S3 hand-off (ADR-009): A's policy declares
 * `policy_requires_articles: [B]` and B is not yet `done`. The dispatcher
 * must emit a `requires_chain` agent_needed event targeting B (not A) so
 * the harness can advance B and unblock A on the next wave.
 *
 * This is the explicit S2→S3 contract verification: the existing
 * dispatcher (S2) is extended additively to handle the new violation
 * shape; A stays in `guardFailures` (not `items`), and the emitted event
 * for B carries `triggeredBy.blockingArticle = A.id`.
 */
describe("requires-chain dispatch (integration)", () => {
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
    return { knowledgeRepo, workRepo, eventRepo, service, dispatcher };
  }

  it("dispatches agent_needed on B when A's policy requires B done", async () => {
    const { knowledgeRepo, workRepo, eventRepo, service } = await setup();

    // B is the work article that must be `done` before A can advance.
    const bResult = await workRepo.create({
      title: "B — must be done first",
      template: WorkTemplate.FEATURE,
      priority: Priority.HIGH,
      author: agentId("author-b"),
      content: "## Objective\nFinish B\n\n## Acceptance Criteria\n- ok",
    });
    if (!bResult.ok) throw new Error(bResult.error.message);
    const bId = bResult.value.id;

    // Move B into enrichment so it has a forward edge for the dispatch
    // to target (planning→enrichment is gateless, but enrichment→implementation
    // requires min_enrichment_met which is unmet → B has its own guard
    // failure the dispatcher could in principle dispatch on).
    const bAdvance = await workRepo.advancePhase(bId, WorkPhase.ENRICHMENT);
    if (!bAdvance.ok) throw new Error(bAdvance.error.message);

    // Policy: enrichment→implementation requires reference to B.
    const policyResult = await knowledgeRepo.create({
      id: articleId("k-policy-requires-b"),
      title: "Policy: A must reference and wait for B",
      slug: "policy-a-requires-b" as never,
      category: POLICY_CATEGORY,
      content: "A composes B; B's contract must be stable.",
      extraFrontmatter: {
        policy_applies_templates: ["feature"],
        policy_phase_transition: "enrichment->implementation",
        policy_requires_roles: [],
        policy_requires_articles: [bId],
        policy_rationale: "B publishes the contract A consumes.",
      },
    });
    if (!policyResult.ok) throw new Error(policyResult.error.message);

    // A: references B and has architecture enrichment contributed so the
    // ONLY blocker is the requires_chain hard block.
    const aResult = await workRepo.create({
      title: "A — depends on B",
      template: WorkTemplate.FEATURE,
      priority: Priority.HIGH,
      author: agentId("author-a"),
      content: "## Objective\nDo A\n\n## Acceptance Criteria\n- composes B",
      references: [bId],
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("arch-agent"), status: "contributed" },
      ],
    });
    if (!aResult.ok) throw new Error(aResult.error.message);
    const aId = aResult.value.id;

    // Move A into enrichment; planWave will then evaluate A's
    // enrichment→implementation transition where the policy applies.
    const aAdvance = await workRepo.advancePhase(aId, WorkPhase.ENRICHMENT);
    if (!aAdvance.ok) throw new Error(aAdvance.error.message);

    // Plan + execute the wave.
    const plan = await service.planWave();
    if (!plan.ok) throw new Error(plan.error.message);

    // A must be a guard failure — policy_requirements_met failing because B is not done.
    const aFailure = plan.value.guardFailures.find((f) => f.workId === aId);
    expect(aFailure, "A should fail policy_requirements_met").toBeTruthy();
    expect(aFailure!.failed.map((g) => g.name)).toContain("policy_requirements_met");
    expect(plan.value.items.find((i) => i.workId === aId)).toBeUndefined();

    const wave = await service.executeWave(plan.value);
    if (!wave.ok) throw new Error(wave.error.message);

    // The dispatched list must include a requires_chain slot targeted at B.
    const requiresChain = wave.value.dispatched.find(
      (d) => d.workId === bId && d.reason === "requires_chain",
    );
    expect(requiresChain, "expected a requires_chain dispatch on B").toBeTruthy();
    expect(requiresChain!.triggeredBy.blockingArticle).toBe(aId);
    expect(requiresChain!.triggeredBy.policySlug).toBe("policy-a-requires-b");
    expect(requiresChain!.role).toBe("author");
    // B is in enrichment, next phase is implementation.
    expect(requiresChain!.transition.from).toBe(WorkPhase.ENRICHMENT);
    expect(requiresChain!.transition.to).toBe(WorkPhase.IMPLEMENTATION);

    // The requires_chain event must be persisted on B with the correct
    // metadata. B may also have a separate `template_enrichment` event
    // from its own `min_enrichment_met` failure — that's expected and
    // intended (planWave evaluates B independently); we only assert on
    // the requires_chain one here.
    const bEvents = await eventRepo.findByWorkId(bId);
    if (!bEvents.ok) throw new Error(bEvents.error.message);
    const requiresChainEvent = bEvents.value.find((e) => {
      if (e.eventType !== "agent_needed") return false;
      const d = e.details as unknown as AgentNeededDetails;
      return d.reason === "requires_chain";
    });
    expect(requiresChainEvent, "requires_chain agent_needed must be persisted against B").toBeTruthy();
    const details = requiresChainEvent!.details as unknown as AgentNeededDetails;
    expect(details.triggeredBy.blockingArticle).toBe(aId);
    expect(details.contextPackSummary.workArticleSlug).toBe(bId);
    expect(
      details.contextPackSummary.guidance.some((line) => line.includes(`Advance ${bId}`)),
    ).toBe(true);
  });

  it("does not emit a requires_chain dispatch when the referenced article is already done", async () => {
    const { knowledgeRepo, workRepo, service } = await setup();

    // Stand up B and walk it to done.
    const bResult = await workRepo.create({
      title: "B — done",
      template: WorkTemplate.FEATURE,
      priority: Priority.HIGH,
      author: agentId("author-b"),
      content: "## Objective\nx\n\n## Acceptance Criteria\n- ok\n\n## Implementation\n- y",
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("a"), status: "contributed" },
      ],
      reviewers: [
        { agentId: agentId("rev-1"), status: "approved" },
      ],
    });
    if (!bResult.ok) throw new Error(bResult.error.message);
    const bId = bResult.value.id;
    for (const phase of [WorkPhase.ENRICHMENT, WorkPhase.IMPLEMENTATION, WorkPhase.REVIEW, WorkPhase.DONE]) {
      const r = await workRepo.advancePhase(bId, phase);
      if (!r.ok) throw new Error(`B → ${phase}: ${r.error.message}`);
    }

    const policyResult = await knowledgeRepo.create({
      id: articleId("k-policy-requires-b-done"),
      title: "Policy: A must reference B (which IS done)",
      slug: "policy-requires-b-done" as never,
      category: POLICY_CATEGORY,
      content: "B is the contract.",
      extraFrontmatter: {
        policy_applies_templates: ["feature"],
        policy_phase_transition: "enrichment->implementation",
        policy_requires_roles: [],
        policy_requires_articles: [bId],
        policy_rationale: "Done is done.",
      },
    });
    if (!policyResult.ok) throw new Error(policyResult.error.message);

    const aResult = await workRepo.create({
      title: "A — depends on a done B",
      template: WorkTemplate.FEATURE,
      priority: Priority.HIGH,
      author: agentId("author-a"),
      content: "## Objective\nx\n\n## Acceptance Criteria\n- ok",
      references: [bId],
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("a"), status: "contributed" },
      ],
    });
    if (!aResult.ok) throw new Error(aResult.error.message);
    await workRepo.advancePhase(aResult.value.id, WorkPhase.ENRICHMENT);

    const plan = await service.planWave();
    if (!plan.ok) throw new Error(plan.error.message);
    const wave = await service.executeWave(plan.value);
    if (!wave.ok) throw new Error(wave.error.message);

    const chainDispatch = wave.value.dispatched.find(
      (d) => d.reason === "requires_chain",
    );
    expect(chainDispatch, "no requires_chain dispatch when reference is done").toBeUndefined();
  });
});
