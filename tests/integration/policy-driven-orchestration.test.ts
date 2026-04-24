import { describe, it, expect } from "vitest";
import { OrchestrationService } from "../../src/orchestration/service.js";
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
} from "../../src/core/types.js";

/**
 * End-to-end: a policy article authored in the knowledge base gates a work
 * article from advancing until the required enrichment role contributes. No
 * TypeScript was touched to author the policy — that is the whole point of
 * ADR-007.
 */
describe("policy-driven orchestration (integration)", () => {
  async function setup() {
    const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
    const workRepo = new InMemoryWorkArticleRepository();
    const orchestrationRepo = new InMemoryOrchestrationEventRepository();
    const logger = createLogger({ level: "error", domain: "test" });
    const policyLoader = new PolicyLoader({ knowledgeRepo, logger });
    const service = new OrchestrationService({
      workRepo,
      orchestrationRepo,
      logger,
      policyLoader,
    });
    return { knowledgeRepo, workRepo, service, policyLoader };
  }

  it("blocks enrichment->implementation until the required role contributes", async () => {
    const { knowledgeRepo, workRepo, service, policyLoader } = await setup();

    // Seed the policy as a knowledge article — no code changes required.
    const policyResult = await knowledgeRepo.create({
      id: articleId("k-policy-security"),
      title: "Policy: features touching auth require security enrichment",
      slug: "policy-feature-auth-security" as never,
      category: POLICY_CATEGORY,
      content: "Auth code crosses a trust boundary; security reviews it before implementation.",
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

    // Create a feature work article whose content matches the policy's regex.
    // We attach a `security` role explicitly — in real use, a pre-hook or agent
    // adds it when a matching policy is detected. Here we do it at creation for
    // the integration test to exercise the path end-to-end.
    const createResult = await workRepo.create({
      title: "Add OAuth login",
      template: WorkTemplate.FEATURE,
      priority: Priority.HIGH,
      author: agentId("agent-a"),
      content: "## Objective\n\nAdd OAuth login.\n\n## Acceptance Criteria\n\n- Works",
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("arch-agent"), status: "pending" },
        { role: "security", agentId: agentId("sec-agent"), status: "pending" },
      ],
    });
    if (!createResult.ok) throw new Error(createResult.error.message);
    const article = createResult.value;

    // Satisfy the template's own guard (min_enrichment_met=1 for feature) so
    // only the policy guard remains as the blocker.
    const advanceOk = await workRepo.advancePhase(article.id, WorkPhase.ENRICHMENT);
    if (!advanceOk.ok) throw new Error(advanceOk.error.message);
    const archContrib = await workRepo.contributeEnrichment(article.id, "architecture", "contributed");
    if (!archContrib.ok) throw new Error(archContrib.error.message);

    // Verify the policy is loaded.
    const policies = await policyLoader.getAll();
    expect(policies).toHaveLength(1);

    // Readiness check should now fail — security enrichment is missing.
    const readiness1 = await service.evaluateReadiness(article.id);
    if (!readiness1.ok) throw new Error(readiness1.error.message);
    expect(readiness1.value.ready).toBe(false);
    const failedNames = readiness1.value.guardResults
      .filter((g) => !g.passed)
      .map((g) => g.name);
    expect(failedNames).toContain("policy_requirements_met");

    // planWave must NOT include this article yet.
    const plan1 = await service.planWave();
    if (!plan1.ok) throw new Error(plan1.error.message);
    const planned1 = plan1.value.items.find((i) => i.workId === article.id);
    expect(planned1).toBeUndefined();

    // Now satisfy the policy: security contributes.
    const secContrib = await workRepo.contributeEnrichment(article.id, "security", "contributed");
    if (!secContrib.ok) throw new Error(secContrib.error.message);

    // Re-evaluate — should be ready, and the next planWave should include it.
    const readiness2 = await service.evaluateReadiness(article.id);
    if (!readiness2.ok) throw new Error(readiness2.error.message);
    expect(readiness2.value.ready).toBe(true);

    const plan2 = await service.planWave();
    if (!plan2.ok) throw new Error(plan2.error.message);
    const planned2 = plan2.value.items.find((i) => i.workId === article.id);
    expect(planned2).toEqual({
      workId: article.id,
      from: WorkPhase.ENRICHMENT,
      to: WorkPhase.IMPLEMENTATION,
    });
  });

  it("does not gate articles whose content does not match any policy", async () => {
    const { knowledgeRepo, workRepo, service } = await setup();

    await knowledgeRepo.create({
      id: articleId("k-policy-security"),
      title: "Policy: auth features require security",
      slug: "policy-feature-auth-security" as never,
      category: POLICY_CATEGORY,
      content: "",
      extraFrontmatter: {
        policy_applies_templates: ["feature"],
        policy_phase_transition: "enrichment->implementation",
        policy_content_matches: ["(?i)auth|oauth"],
        policy_requires_roles: ["security"],
      },
    });

    const createResult = await workRepo.create({
      title: "Cache warmup",
      template: WorkTemplate.FEATURE,
      priority: Priority.MEDIUM,
      author: agentId("agent-a"),
      content: "## Objective\n\nWarm the cache on boot.\n\n## Acceptance Criteria\n\n- Works",
      enrichmentRoles: [
        { role: "architecture", agentId: agentId("arch-agent"), status: "pending" },
      ],
    });
    if (!createResult.ok) throw new Error(createResult.error.message);
    const article = createResult.value;

    await workRepo.advancePhase(article.id, WorkPhase.ENRICHMENT);
    await workRepo.contributeEnrichment(article.id, "architecture", "contributed");

    const readiness = await service.evaluateReadiness(article.id);
    if (!readiness.ok) throw new Error(readiness.error.message);
    expect(readiness.value.ready).toBe(true);
  });
});
