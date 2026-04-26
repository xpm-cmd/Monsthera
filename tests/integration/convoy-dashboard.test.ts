import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboard, type DashboardServer } from "../../src/dashboard/index.js";
import { createTestContainer, type MonstheraContainer } from "../../src/core/container.js";
import { workId } from "../../src/core/types.js";

let container: MonstheraContainer;
let dashboard: DashboardServer;
let baseUrl: string;
let authToken: string;

beforeAll(async () => {
  container = await createTestContainer();
  dashboard = await startDashboard(container, 0, {});
  baseUrl = "http://127.0.0.1:" + dashboard.port;
  authToken = dashboard.authToken;
});

afterAll(async () => {
  await dashboard.close();
  await container.dispose();
});

async function api(path: string) {
  const res = await fetch(baseUrl + path, { headers: { Authorization: "Bearer " + authToken } });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body };
}

async function createWork(title: string) {
  const r = await container.workService.createWork({
    title,
    template: "feature",
    priority: "medium",
    author: "agent-test",
    content: "## Objective\nx\n\n## Acceptance Criteria\n- ok",
  });
  if (!r.ok) throw new Error("createWork " + title);
  return r.value;
}

describe("GET /api/convoys -- lifecycle", () => {
  it("active then warning then resolved lifecycle", async () => {
    const lead = await createWork("convoy-int-lead");
    const member = await createWork("convoy-int-member");

    const convoy = await container.convoyRepo.create({
      leadWorkId: workId(lead.id),
      memberWorkIds: [workId(member.id)],
      goal: "integration test",
    });
    if (!convoy.ok) throw new Error("convoy create failed");
    const convoyId = convoy.value.id;

    // 1. Active with no warning
    const r1 = await api("/api/convoys");
    expect(r1.status).toBe(200);
    const body1 = r1.body as { active: Array<{ id: string }>; warnings: unknown[] };
    expect(body1.active.some((c: { id: string }) => c.id === convoyId)).toBe(true);
    expect(body1.warnings).toHaveLength(0);

    // 2. Cancel lead warning appears
    await container.workService.advancePhase(lead.id, "cancelled", { reason: "scope cut" });
    const r2 = await api("/api/convoys");
    expect(r2.status).toBe(200);
    const body2 = r2.body as { warnings: Array<{ convoyId: string; reason: string; activeMemberCount: number }> };
    expect(body2.warnings).toHaveLength(1);
    expect(body2.warnings[0]).toMatchObject({ convoyId, reason: "scope cut", activeMemberCount: 1 });

    // 3. Cancel convoy warning resolved
    await container.convoyRepo.cancel(convoyId, { terminationReason: "lead gone" });
    const r3 = await api("/api/convoys");
    expect(r3.status).toBe(200);
    const body3 = r3.body as { warnings: unknown[] };
    expect(body3.warnings).toHaveLength(0);
  });
});

describe("GET /api/convoys/:id", () => {
  it("returns guard and lifecycle for active convoy", async () => {
    const lead = await createWork("detail-int-lead");
    const member = await createWork("detail-int-member");

    const convoy = await container.convoyRepo.create({
      leadWorkId: workId(lead.id),
      memberWorkIds: [workId(member.id)],
      goal: "detail integration",
    });
    if (!convoy.ok) throw new Error("convoy create failed");
    const convoyId = convoy.value.id;

    const r = await api("/api/convoys/" + encodeURIComponent(convoyId));
    expect(r.status).toBe(200);
    const body = r.body as { guard: { passing: boolean }; lifecycle: Array<{ eventType: string }> };
    expect(body.guard.passing).toBe(false);
    expect(body.lifecycle.some((l: { eventType: string }) => l.eventType === "convoy_created")).toBe(true);
  });

  it("returns 404 for unknown convoy id", async () => {
    const r = await api("/api/convoys/cv-does-not-exist");
    expect(r.status).toBe(404);
  });
});
