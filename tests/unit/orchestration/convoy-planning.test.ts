import { beforeEach, describe, expect, it } from "vitest";
import { OrchestrationService } from "../../../src/orchestration/service.js";
import { InMemoryConvoyRepository } from "../../../src/orchestration/in-memory-convoy-repository.js";
import { InMemoryOrchestrationEventRepository } from "../../../src/orchestration/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { Priority, WorkPhase, WorkTemplate, agentId, workId as toWorkId } from "../../../src/core/types.js";
import type { WorkArticle } from "../../../src/work/repository.js";

/**
 * Convoy planning (ADR-009): a member work article must wait for its lead
 * to reach `targetPhase` before it can be included in a wave's `items`.
 */
describe("convoy planning", () => {
  let workRepo: InMemoryWorkArticleRepository;
  let convoyRepo: InMemoryConvoyRepository;
  let service: OrchestrationService;

  beforeEach(() => {
    workRepo = new InMemoryWorkArticleRepository();
    convoyRepo = new InMemoryConvoyRepository();
    service = new OrchestrationService({
      workRepo,
      orchestrationRepo: new InMemoryOrchestrationEventRepository(),
      logger: createLogger({ level: "error", domain: "test" }),
      convoyRepo,
    });
  });

  async function seedReadyArticle(title: string, content?: string): Promise<WorkArticle> {
    const created = await workRepo.create({
      title,
      template: WorkTemplate.SPIKE,
      priority: Priority.MEDIUM,
      author: agentId("agent-1"),
    });
    if (!created.ok) throw new Error(`seed ${title}: ${created.error.message}`);
    let article = created.value;
    if (content) {
      const upd = await workRepo.update(article.id, { content });
      if (!upd.ok) throw new Error(`update ${title}: ${upd.error.message}`);
      article = upd.value;
    }
    return article;
  }

  async function advanceTo(id: string, ...phases: readonly typeof WorkPhase[keyof typeof WorkPhase][]): Promise<void> {
    for (const phase of phases) {
      const result = await workRepo.advancePhase(toWorkId(id), phase);
      if (!result.ok) throw new Error(`advance ${id} → ${phase}: ${result.error.message}`);
    }
  }

  it("excludes member from wave items until lead reaches targetPhase", async () => {
    // Spike template phase order: planning → enrichment → done.
    // We use targetPhase=enrichment so the lead must be advanced once.
    const lead = await seedReadyArticle("lead", "## Objective\n");
    const member = await seedReadyArticle("member", "## Objective\n");

    const convoyResult = await convoyRepo.create({
      leadWorkId: lead.id,
      memberWorkIds: [member.id],
      goal: "ship the convoy",
      targetPhase: WorkPhase.ENRICHMENT,
    });
    if (!convoyResult.ok) throw new Error(convoyResult.error.message);

    // Both are in `planning`. Lead has not reached `enrichment` yet —
    // member must be a guard failure on `convoy_lead_ready`, lead must
    // still be eligible to advance.
    const beforePlan = await service.planWave();
    if (!beforePlan.ok) throw new Error(beforePlan.error.message);

    const memberFailure = beforePlan.value.guardFailures.find((f) => f.workId === member.id);
    expect(memberFailure, "member should surface a guard failure").toBeTruthy();
    expect(memberFailure!.failed.map((g) => g.name)).toContain("convoy_lead_ready");

    const leadInItems = beforePlan.value.items.find((i) => i.workId === lead.id);
    expect(leadInItems, "lead's own progress is unaffected by the convoy guard").toBeTruthy();

    // Advance the lead into enrichment. Now the member must be unblocked.
    await advanceTo(lead.id, WorkPhase.ENRICHMENT);
    const afterPlan = await service.planWave();
    if (!afterPlan.ok) throw new Error(afterPlan.error.message);

    const memberStillFailing = afterPlan.value.guardFailures.find(
      (f) => f.workId === member.id && f.failed.some((g) => g.name === "convoy_lead_ready"),
    );
    expect(memberStillFailing, "member should no longer fail on convoy_lead_ready").toBeUndefined();

    const memberInItems = afterPlan.value.items.find((i) => i.workId === member.id);
    expect(memberInItems, "member should be eligible once lead reaches target").toBeTruthy();
  });

  it("does not block cancellation transitions", async () => {
    // Member with a not-yet-ready lead should still be cancellable.
    const lead = await seedReadyArticle("lead", "## Objective\n");
    const member = await seedReadyArticle("member", "## Objective\n");

    await convoyRepo.create({
      leadWorkId: lead.id,
      memberWorkIds: [member.id],
      goal: "test cancellation",
      targetPhase: WorkPhase.DONE,
    });

    // Direct cancellation through the work repo (orchestrator does not
    // gate cancellation). The convoy guard's terminal-transition gate is
    // what we rely on at the lifecycle layer — verify it doesn't surface
    // here either.
    const cancel = await workRepo.advancePhase(toWorkId(member.id), WorkPhase.CANCELLED);
    expect(cancel.ok).toBe(true);
  });

  it("convoy lead's own guard set is unaffected (lead is not in lookup)", async () => {
    // Lead and a member; advance lead — wave plan must include lead in
    // items (no convoy_lead_ready blocking the lead itself).
    const lead = await seedReadyArticle("lead", "## Objective\n");
    const member = await seedReadyArticle("member", "## Objective\n");
    await convoyRepo.create({
      leadWorkId: lead.id,
      memberWorkIds: [member.id],
      goal: "verify lead is exempt",
      targetPhase: WorkPhase.ENRICHMENT,
    });

    const plan = await service.planWave();
    if (!plan.ok) throw new Error(plan.error.message);

    const leadFailure = plan.value.guardFailures.find((f) => f.workId === lead.id);
    expect(leadFailure, "lead must not have a convoy_lead_ready failure").toBeUndefined();
    expect(plan.value.items.find((i) => i.workId === lead.id)).toBeTruthy();
  });

  it("completed convoys do not gate any members", async () => {
    const lead = await seedReadyArticle("lead", "## Objective\n");
    const member = await seedReadyArticle("member", "## Objective\n");
    const convoy = await convoyRepo.create({
      leadWorkId: lead.id,
      memberWorkIds: [member.id],
      goal: "complete me",
      targetPhase: WorkPhase.DONE,
    });
    if (!convoy.ok) throw new Error(convoy.error.message);

    // Completing the convoy removes it from `findActive`; the member
    // becomes unblocked even though the lead never reached `done`.
    const completeResult = await convoyRepo.complete(convoy.value.id);
    expect(completeResult.ok).toBe(true);

    const plan = await service.planWave();
    if (!plan.ok) throw new Error(plan.error.message);
    const memberFailure = plan.value.guardFailures.find(
      (f) => f.workId === member.id && f.failed.some((g) => g.name === "convoy_lead_ready"),
    );
    expect(memberFailure).toBeUndefined();
  });
});
