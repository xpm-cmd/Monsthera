import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDashboard } from "../../../src/dashboard/index.js";
import type { DashboardServer } from "../../../src/dashboard/index.js";
import { createTestContainer } from "../../../src/core/container.js";
import type { MonstheraContainer } from "../../../src/core/container.js";
import { agentId } from "../../../src/core/types.js";

/**
 * Overview-page contract tests. A fresh container per describe so the
 * "empty agent directory" case is actually empty — dashboard.test.ts
 * shares a container and seeds agents in other test blocks, which
 * prevents testing the zero-state contract there.
 *
 * These tests are not true browser E2E (that would require Playwright
 * and new deps). They instead pin the HTTP-layer data contracts that
 * public/pages/overview.js depends on for its empty-state rendering
 * and its lucide icon bootstrap.
 */

const FIXTURES_PUBLIC = path.resolve(import.meta.dirname, "../../fixtures/public");

let container: MonstheraContainer;
let dashboard: DashboardServer | undefined;
let dashboardError: NodeJS.ErrnoException | undefined;

beforeAll(async () => {
  try {
    container = await createTestContainer();
    dashboard = await startDashboard(container, 0, { publicDir: FIXTURES_PUBLIC });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      dashboardError = error as NodeJS.ErrnoException;
      return;
    }
    throw error;
  }
});

afterAll(async () => {
  if (dashboard) {
    await dashboard.close();
  }
  if (container) {
    await container.dispose();
  }
});

function url(p: string): string {
  if (dashboardError || !dashboard) return "http://127.0.0.1/unavailable";
  return `http://localhost:${dashboard.port}${p}`;
}

describe("Overview empty-state contract", () => {
  it("/api/agents returns totalAgents=0 on a fresh corpus", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/api/agents"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { totalAgents: number; activeAgents: number };
      agents: Array<{ id: string }>;
    };
    // These two fields are what public/pages/overview.js reads to decide
    // whether to render the "No agents yet" CTA. If this contract ever
    // changes the UI must change too.
    expect(body.summary.totalAgents).toBe(0);
    expect(body.summary.activeAgents).toBe(0);
    expect(body.agents).toEqual([]);
  });

  it("/api/agents summary populates once a work article references agents", async () => {
    if (dashboardError) return;
    // Seed a work article with an assignee; the dashboard derives agents
    // from work references rather than a separate registration table.
    const created = await container.workRepo.create({
      title: "Empty-state regression seed",
      template: "feature",
      priority: "medium",
      author: agentId("empty-state-author"),
      assignee: agentId("empty-state-assignee"),
      content: "## Objective\nSeed\n\n## Acceptance Criteria\n- [ ] done",
    });
    expect(created.ok).toBe(true);

    const res = await fetch(url("/api/agents"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { totalAgents: number };
      agents: Array<{ id: string }>;
    };
    expect(body.summary.totalAgents).toBeGreaterThan(0);
    expect(body.agents.some((a) => a.id === "empty-state-assignee")).toBe(true);
  });
});

describe("Dashboard HTML lucide pin", () => {
  it("serves the bundled index.html with a pinned lucide version (no @latest)", async () => {
    // This test uses the real public/ folder rather than the fixture —
    // otherwise we would assert against the fixture's lucide reference
    // instead of the real dashboard. Spin up a second dashboard.
    const realPublic = path.resolve(import.meta.dirname, "../../../public");
    const realContainer = await createTestContainer();
    let realDashboard: DashboardServer | undefined;
    try {
      realDashboard = await startDashboard(realContainer, 0, { publicDir: realPublic });
      const res = await fetch(`http://localhost:${realDashboard.port}/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("unpkg.com/lucide@");
      expect(html).not.toContain("lucide@latest");
      // Version should be a semver-looking string, not `latest`.
      const match = html.match(/lucide@([^/"\s]+)/);
      expect(match).not.toBeNull();
      expect(match![1]).toMatch(/^\d+\.\d+\.\d+$/);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    } finally {
      if (realDashboard) await realDashboard.close();
      await realContainer.dispose();
    }
  });
});

describe("Smoke-flow parity (advance + rename + batch)", () => {
  it("advances a work article through enrichment and then cancels it with a reason", async () => {
    if (dashboardError) return;
    const created = await container.workRepo.create({
      title: "Smoke Advance Flow",
      template: "feature",
      priority: "medium",
      author: agentId("smoke-author"),
      content: "## Objective\nAdvance\n\n## Acceptance Criteria\n- [ ] ok",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const advanceRes = await fetch(url(`/api/work/${created.value.id}/advance`), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${dashboard?.authToken ?? ""}`,
      },
      body: JSON.stringify({ phase: "enrichment" }),
    });
    expect(advanceRes.status).toBe(200);
    const advanced = (await advanceRes.json()) as { phase: string };
    expect(advanced.phase).toBe("enrichment");

    const cancelRes = await fetch(url(`/api/work/${created.value.id}/advance`), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${dashboard?.authToken ?? ""}`,
      },
      body: JSON.stringify({ phase: "cancelled", reason: "Superseded" }),
    });
    expect(cancelRes.status).toBe(200);
    const cancelled = (await cancelRes.json()) as {
      phase: string;
      phaseHistory: Array<{ phase: string; reason?: string }>;
    };
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.phaseHistory.find((p) => p.phase === "cancelled")?.reason).toBe("Superseded");
  });

  it("renames a knowledge article slug and preserves references in other articles", async () => {
    if (dashboardError) return;
    const target = await container.knowledgeService.createArticle({
      title: "Rename Flow Target",
      category: "engineering",
      content: "Target body",
    });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const referrer = await container.knowledgeService.createArticle({
      title: "Rename Flow Referrer",
      category: "engineering",
      content: "Referrer body",
      references: [target.value.slug],
    });
    expect(referrer.ok).toBe(true);
    if (!referrer.ok) return;

    const renameRes = await fetch(url(`/api/knowledge/${target.value.id}`), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${dashboard?.authToken ?? ""}`,
      },
      body: JSON.stringify({ new_slug: "rename-flow-target-renamed" }),
    });
    expect(renameRes.status).toBe(200);
    const renamed = (await renameRes.json()) as { slug: string };
    expect(renamed.slug).toBe("rename-flow-target-renamed");

    const refResult = await container.knowledgeRepo.findById(referrer.value.id);
    expect(refResult.ok).toBe(true);
    if (refResult.ok) {
      expect(refResult.value.references).toContain("rename-flow-target-renamed");
    }
  });

  it("accepts a JSON batch import and reports per-item success", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/api/knowledge/batch"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${dashboard?.authToken ?? ""}`,
      },
      body: JSON.stringify({
        articles: [
          { title: "Smoke Batch 1", category: "engineering", content: "a" },
          { title: "Smoke Batch 2", category: "engineering", content: "b" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      succeeded: number;
      items: Array<{ ok: boolean }>;
    };
    expect(body.total).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(body.items.every((i) => i.ok)).toBe(true);
  });
});
