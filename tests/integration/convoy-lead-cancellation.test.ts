import { describe, expect, it } from "vitest";
import { createTestContainer } from "../../src/core/container.js";
import { workId } from "../../src/core/types.js";

/**
 * ADR-013 §3 — when the lead of an active convoy is cancelled, the work
 * service emits a `convoy_lead_cancelled_warning` event carrying the
 * convoy id, lead, members, and the cancellation reason. Members are NOT
 * auto-cancelled; the warning IS the operator's signal to decide.
 *
 * Uses `createTestContainer()` so the full wiring (work service +
 * convoy repo + orchestration event repo) exercises the production
 * code path without standing up Dolt.
 */
describe("Integration: convoy lead cancellation warning", () => {
  it("emits convoy_lead_cancelled_warning when an active convoy's lead is cancelled", async () => {
    const container = await createTestContainer();
    try {
      const lead = await container.workService.createWork({
        title: "lead",
        template: "feature",
        priority: "medium",
        author: "agent-test",
        content: "## Objective\nx\n\n## Acceptance Criteria\n- ok",
      });
      if (!lead.ok) throw new Error("lead create failed");
      const memberA = await container.workService.createWork({
        title: "member-a",
        template: "feature",
        priority: "medium",
        author: "agent-test",
        content: "## Objective\nx\n\n## Acceptance Criteria\n- ok",
      });
      if (!memberA.ok) throw new Error("member-a create failed");
      const memberB = await container.workService.createWork({
        title: "member-b",
        template: "feature",
        priority: "medium",
        author: "agent-test",
        content: "## Objective\nx\n\n## Acceptance Criteria\n- ok",
      });
      if (!memberB.ok) throw new Error("member-b create failed");

      const convoy = await container.convoyRepo.create({
        leadWorkId: workId(lead.value.id),
        memberWorkIds: [workId(memberA.value.id), workId(memberB.value.id)],
        goal: "ship X",
      });
      if (!convoy.ok) throw new Error("convoy create failed");

      const cancelled = await container.workService.advancePhase(
        lead.value.id,
        "cancelled",
        { reason: "scope cut" },
      );
      expect(cancelled.ok).toBe(true);

      const warnings = await container.orchestrationRepo.findByType(
        "convoy_lead_cancelled_warning",
      );
      expect(warnings.ok).toBe(true);
      if (!warnings.ok) return;
      expect(warnings.value).toHaveLength(1);
      const event = warnings.value[0]!;
      expect(event.workId).toBe(workId(lead.value.id));
      expect(event.details).toMatchObject({
        convoyId: convoy.value.id,
        leadWorkId: workId(lead.value.id),
        memberWorkIds: [workId(memberA.value.id), workId(memberB.value.id)],
        reason: "scope cut",
      });

      // No auto-cascade: convoy stays active, members stay in their phase.
      const convoyAfter = await container.convoyRepo.findById(convoy.value.id);
      expect(convoyAfter.ok).toBe(true);
      if (!convoyAfter.ok) return;
      expect(convoyAfter.value.status).toBe("active");

      const memberAAfter = await container.workService.getWork(memberA.value.id);
      expect(memberAAfter.ok).toBe(true);
      if (!memberAAfter.ok) return;
      expect(memberAAfter.value.phase).toBe("planning");
    } finally {
      await container.dispose();
    }
  });

  it("does not emit a warning when the cancelled article is only a convoy member", async () => {
    const container = await createTestContainer();
    try {
      const lead = await container.workService.createWork({
        title: "lead",
        template: "feature",
        priority: "medium",
        author: "agent-test",
        content: "## Objective\nx\n\n## Acceptance Criteria\n- ok",
      });
      if (!lead.ok) throw new Error("lead create failed");
      const member = await container.workService.createWork({
        title: "member",
        template: "feature",
        priority: "medium",
        author: "agent-test",
        content: "## Objective\nx\n\n## Acceptance Criteria\n- ok",
      });
      if (!member.ok) throw new Error("member create failed");

      const convoy = await container.convoyRepo.create({
        leadWorkId: workId(lead.value.id),
        memberWorkIds: [workId(member.value.id)],
        goal: "ship X",
      });
      if (!convoy.ok) throw new Error("convoy create failed");

      const cancelled = await container.workService.advancePhase(
        member.value.id,
        "cancelled",
        { reason: "member abandoned" },
      );
      expect(cancelled.ok).toBe(true);

      const warnings = await container.orchestrationRepo.findByType(
        "convoy_lead_cancelled_warning",
      );
      expect(warnings.ok).toBe(true);
      if (!warnings.ok) return;
      expect(warnings.value).toHaveLength(0);
    } finally {
      await container.dispose();
    }
  });

  it("does not emit a warning when the cancelled article was lead of a convoy that is already terminal", async () => {
    const container = await createTestContainer();
    try {
      const lead = await container.workService.createWork({
        title: "lead",
        template: "feature",
        priority: "medium",
        author: "agent-test",
        content: "## Objective\nx\n\n## Acceptance Criteria\n- ok",
      });
      if (!lead.ok) throw new Error("lead create failed");
      const member = await container.workService.createWork({
        title: "member",
        template: "feature",
        priority: "medium",
        author: "agent-test",
        content: "## Objective\nx\n\n## Acceptance Criteria\n- ok",
      });
      if (!member.ok) throw new Error("member create failed");

      const convoy = await container.convoyRepo.create({
        leadWorkId: workId(lead.value.id),
        memberWorkIds: [workId(member.value.id)],
        goal: "ship X",
      });
      if (!convoy.ok) throw new Error("convoy create failed");
      const terminal = await container.convoyRepo.complete(convoy.value.id);
      expect(terminal.ok).toBe(true);

      const cancelled = await container.workService.advancePhase(
        lead.value.id,
        "cancelled",
        { reason: "lead abandoned post-convoy-completion" },
      );
      expect(cancelled.ok).toBe(true);

      const warnings = await container.orchestrationRepo.findByType(
        "convoy_lead_cancelled_warning",
      );
      expect(warnings.ok).toBe(true);
      if (!warnings.ok) return;
      expect(warnings.value).toHaveLength(0);
    } finally {
      await container.dispose();
    }
  });
});
