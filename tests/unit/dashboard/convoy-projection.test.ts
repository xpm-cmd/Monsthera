import { describe, expect, it } from "vitest";
import { createTestContainer } from "../../../src/core/container.js";
import { workId } from "../../../src/core/types.js";
import { ErrorCode } from "../../../src/core/errors.js";
import {
  buildConvoyDashboardSummary,
  buildConvoyDetail,
  type ConvoyProjectionDeps,
} from "../../../src/dashboard/convoy-projection.js";

async function setupContainer() {
  const container = await createTestContainer();
  const deps: ConvoyProjectionDeps = {
    convoyRepo: container.convoyRepo,
    orchestrationRepo: container.orchestrationRepo,
    workService: container.workService,
    now: () => new Date("2026-04-26T10:00:00Z"),
  };
  return { container, deps };
}

async function createWork(container: Awaited<ReturnType<typeof createTestContainer>>, title: string) {
  const result = await container.workService.createWork({
    title,
    template: "feature",
    priority: "medium",
    author: "agent-test",
    content: "## Objective\nx\n\n## Acceptance Criteria\n- ok",
  });
  if (!result.ok) throw new Error(`createWork ${title} failed: ${result.error.message}`);
  return result.value;
}

describe("buildConvoyDashboardSummary — active convoys", () => {
  it("returns active convoys with lead + members enriched", async () => {
    const { container, deps } = await setupContainer();
    try {
      const lead = await createWork(container, "lead article");
      const memberA = await createWork(container, "member a");
      const memberB = await createWork(container, "member b");

      const convoy = await container.convoyRepo.create({
        leadWorkId: workId(lead.id),
        memberWorkIds: [workId(memberA.id), workId(memberB.id)],
        goal: "ship X",
      });
      if (!convoy.ok) throw new Error("convoy create failed");

      const summary = await buildConvoyDashboardSummary(deps);
      expect(summary.ok).toBe(true);
      if (!summary.ok) return;
      expect(summary.value.active).toHaveLength(1);
      const enriched = summary.value.active[0]!;
      expect(enriched.id).toBe(convoy.value.id);
      expect(enriched.goal).toBe("ship X");
      expect(enriched.lead).toMatchObject({ id: workId(lead.id), title: "lead article" });
      expect(enriched.members).toHaveLength(2);
      expect(enriched.hasUnresolvedWarning).toBe(false);
    } finally {
      await container.dispose();
    }
  });
});

describe("buildConvoyDashboardSummary — deleted refs", () => {
  it("marks deleted work articles as deleted refs", async () => {
    const { container, deps } = await setupContainer();
    try {
      const lead = await createWork(container, "lead to delete");
      const member = await createWork(container, "member stays");

      const convoy = await container.convoyRepo.create({
        leadWorkId: workId(lead.id),
        memberWorkIds: [workId(member.id)],
        goal: "test deleted",
      });
      if (!convoy.ok) throw new Error("convoy create failed");

      // Delete lead via workService.deleteWork
      await container.workService.deleteWork(lead.id);

      const summary = await buildConvoyDashboardSummary(deps);
      expect(summary.ok).toBe(true);
      if (!summary.ok) return;
      expect(summary.value.active).toHaveLength(1);
      const enriched = summary.value.active[0]!;
      expect(enriched.lead).toMatchObject({ id: workId(lead.id), deleted: true });
    } finally {
      await container.dispose();
    }
  });
});

describe("buildConvoyDashboardSummary — warnings", () => {
  it("unresolved warning present after lead is cancelled", async () => {
    const { container, deps } = await setupContainer();
    try {
      const lead = await createWork(container, "lead w");
      const memberA = await createWork(container, "member w-a");

      const convoy = await container.convoyRepo.create({
        leadWorkId: workId(lead.id),
        memberWorkIds: [workId(memberA.id)],
        goal: "warn test",
      });
      if (!convoy.ok) throw new Error("convoy create failed");

      await container.workService.advancePhase(lead.id, "cancelled", { reason: "scope cut" });

      const summary = await buildConvoyDashboardSummary(deps);
      expect(summary.ok).toBe(true);
      if (!summary.ok) return;
      expect(summary.value.warnings).toHaveLength(1);
      expect(summary.value.warnings[0]).toMatchObject({
        convoyId: convoy.value.id,
        reason: "scope cut",
        activeMemberCount: 1,
      });
      const activeConvoy = summary.value.active.find((c) => c.id === convoy.value.id);
      expect(activeConvoy?.hasUnresolvedWarning).toBe(true);
    } finally {
      await container.dispose();
    }
  });

  it("warning resolved by convoy termination", async () => {
    const { container, deps } = await setupContainer();
    try {
      const lead = await createWork(container, "lead cancelled 2");
      const memberA = await createWork(container, "member 2-a");

      const convoy = await container.convoyRepo.create({
        leadWorkId: workId(lead.id),
        memberWorkIds: [workId(memberA.id)],
        goal: "resolve by cancel",
      });
      if (!convoy.ok) throw new Error("convoy create failed");

      await container.workService.advancePhase(lead.id, "cancelled", { reason: "scope cut" });
      await container.convoyRepo.cancel(convoy.value.id, { terminationReason: "follow lead" });

      const summary = await buildConvoyDashboardSummary(deps);
      expect(summary.ok).toBe(true);
      if (!summary.ok) return;
      expect(summary.value.warnings).toHaveLength(0);
    } finally {
      await container.dispose();
    }
  });

  it("warning resolved by all-members-terminal", async () => {
    const { container, deps } = await setupContainer();
    try {
      const lead = await createWork(container, "lead cancelled 3");
      const memberA = await createWork(container, "member 3-a");

      const convoy = await container.convoyRepo.create({
        leadWorkId: workId(lead.id),
        memberWorkIds: [workId(memberA.id)],
        goal: "resolve by members",
      });
      if (!convoy.ok) throw new Error("convoy create failed");

      await container.workService.advancePhase(lead.id, "cancelled", { reason: "scope cut" });
      await container.workService.advancePhase(memberA.id, "cancelled", { reason: "follow" });

      const summary = await buildConvoyDashboardSummary(deps);
      expect(summary.ok).toBe(true);
      if (!summary.ok) return;
      expect(summary.value.warnings).toHaveLength(0);
    } finally {
      await container.dispose();
    }
  });
});

describe("buildConvoyDashboardSummary — terminal convoys", () => {
  it("completed convoys appear in terminal list", async () => {
    const { container, deps } = await setupContainer();
    try {
      const lead = await createWork(container, "lead terminal");
      const member = await createWork(container, "member terminal");

      const convoy = await container.convoyRepo.create({
        leadWorkId: workId(lead.id),
        memberWorkIds: [workId(member.id)],
        goal: "ship terminal",
      });
      if (!convoy.ok) throw new Error("convoy create failed");

      await container.convoyRepo.complete(convoy.value.id, { terminationReason: "shipped" });

      const summary = await buildConvoyDashboardSummary(deps);
      expect(summary.ok).toBe(true);
      if (!summary.ok) return;
      expect(summary.value.terminal).toHaveLength(1);
      expect(summary.value.terminal[0]).toMatchObject({ id: convoy.value.id, status: "completed" });
      expect(summary.value.active).toHaveLength(0);
    } finally {
      await container.dispose();
    }
  });
});

describe("buildConvoyDetail", () => {
  it("unknown id returns NOT_FOUND", async () => {
    const { container, deps } = await setupContainer();
    try {
      const result = await buildConvoyDetail("cv-nope" as never, deps);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
    } finally {
      await container.dispose();
    }
  });

  it("active blocked: guard passing=false and lifecycle has convoy_created", async () => {
    const { container, deps } = await setupContainer();
    try {
      const lead = await createWork(container, "lead detail");
      const member = await createWork(container, "member detail");

      const convoy = await container.convoyRepo.create({
        leadWorkId: workId(lead.id),
        memberWorkIds: [workId(member.id)],
        goal: "detail test",
      });
      if (!convoy.ok) throw new Error("convoy create failed");

      const detail = await buildConvoyDetail(convoy.value.id, deps);
      expect(detail.ok).toBe(true);
      if (!detail.ok) return;
      // lead is in planning, target is implementation → guard should not pass
      expect(detail.value.guard).toMatchObject({ name: "convoy_lead_ready", passing: false, targetPhase: "implementation" });
      expect(detail.value.lifecycle.some((l) => l.eventType === "convoy_created")).toBe(true);
    } finally {
      await container.dispose();
    }
  });

  it("terminal: guard is null, lifecycle has convoy_created and convoy_completed", async () => {
    const { container, deps } = await setupContainer();
    try {
      const lead = await createWork(container, "lead terminal detail");
      const member = await createWork(container, "member terminal detail");

      const convoy = await container.convoyRepo.create({
        leadWorkId: workId(lead.id),
        memberWorkIds: [workId(member.id)],
        goal: "terminal detail test",
      });
      if (!convoy.ok) throw new Error("convoy create failed");

      await container.convoyRepo.complete(convoy.value.id, { terminationReason: "done" });

      const detail = await buildConvoyDetail(convoy.value.id, deps);
      expect(detail.ok).toBe(true);
      if (!detail.ok) return;
      expect(detail.value.guard).toBeNull();
      const eventTypes = detail.value.lifecycle.map((l) => l.eventType);
      expect(eventTypes).toContain("convoy_created");
      expect(eventTypes).toContain("convoy_completed");
    } finally {
      await container.dispose();
    }
  });
});
