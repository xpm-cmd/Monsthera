import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDashboard } from "../../../src/dashboard/index.js";
import type { DashboardServer } from "../../../src/dashboard/index.js";
import { createTestContainer } from "../../../src/core/container.js";
import type { MonstheraContainer } from "../../../src/core/container.js";
import { VERSION } from "../../../src/core/constants.js";
import { agentId } from "../../../src/core/types.js";

const FIXTURES_PUBLIC = path.resolve(import.meta.dirname, "../../fixtures/public");

// ─── Setup / teardown ───────────────────────────────────────────────────────

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

function url(path: string): string {
  if (dashboardError || !dashboard) {
    return "http://127.0.0.1/unavailable";
  }
  return `http://localhost:${dashboard.port}${path}`;
}

/** Headers for authenticated mutating requests. */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${dashboard?.authToken ?? ""}`,
    ...extra,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Dashboard JSON API", () => {
  // ── GET /api/status ───────────────────────────────────────────────────────

  describe("GET /api/status", () => {
    it("returns 200 with JSON containing version", async () => {
      if (dashboardError) return;
      const res = await fetch(url("/api/status"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("version", VERSION);
    });

    it("responds with Content-Type application/json", async () => {
      if (dashboardError) return;
      const res = await fetch(url("/api/status"));
      expect(res.headers.get("content-type")).toBe("application/json");
    });
  });

  describe("GET /api/system/runtime", () => {
    it("returns runtime config, capabilities, and recent events", async () => {
      if (dashboardError) return;

      const created = await container.workService.createWork({
        title: "Runtime Event Seed",
        template: "feature",
        priority: "medium",
        author: "agent-runtime",
        content: "## Objective\nSeed runtime\n\n## Acceptance Criteria\n- [ ] done",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      await container.workService.advancePhase(created.value.id, "enrichment");

      const res = await fetch(url("/api/system/runtime"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        capabilities: {
          workCrud: boolean;
          migrationAvailable: boolean;
          agentDirectory: boolean;
          knowledgeIngest: boolean;
          searchAutoSync: boolean;
          contextPacks: boolean;
          wavePlanning: boolean;
          waveExecution: boolean;
        };
        agentExperience: {
          scores: { overall: number };
          recommendations: Array<{ id: string }>;
          search: { autoSync: boolean };
        } | null;
        integrations: Array<{ id: string }>;
        recentEvents: Array<{ workId: string; eventType: string }>;
      };

      expect(body.capabilities.workCrud).toBe(true);
      expect(body.capabilities.agentDirectory).toBe(true);
      expect(body.capabilities.knowledgeIngest).toBe(true);
      expect(body.capabilities.searchAutoSync).toBe(true);
      expect(body.capabilities.contextPacks).toBe(true);
      expect(body.capabilities.wavePlanning).toBe(true);
      expect(body.capabilities.waveExecution).toBe(true);
      expect(body.agentExperience).not.toBeNull();
      expect(body.agentExperience?.scores.overall).toBeGreaterThanOrEqual(0);
      expect(body.agentExperience?.search.autoSync).toBe(true);
      expect(body.agentExperience?.recommendations.some((item) => item.id === "add-context-links")).toBe(true);
      expect(body.agentExperience?.recommendations.some((item) => item.id === "assign-owners")).toBe(true);
      expect(Array.isArray(body.integrations)).toBe(true);
      expect(body.integrations.some((integration) => integration.id === "markdown")).toBe(true);
      expect(body.integrations.some((integration) => integration.id === "search-auto-sync")).toBe(true);
      expect(body.recentEvents.some((event) => event.workId === created.value.id && event.eventType === "phase_advanced")).toBe(true);
    });
  });

  describe("GET /api/orchestration/wave", () => {
    it("returns ready and blocked wave items with summaries", async () => {
      if (dashboardError) return;

      const blocker = await container.workService.createWork({
        title: "Wave blocker",
        template: "feature",
        priority: "medium",
        author: "agent-wave",
      });
      expect(blocker.ok).toBe(true);
      if (!blocker.ok) return;

      const ready = await container.workService.createWork({
        title: "Wave ready",
        template: "feature",
        priority: "medium",
        author: "agent-wave",
        content: "## Objective\nReady\n\n## Acceptance Criteria\n- [ ] yes",
      });
      expect(ready.ok).toBe(true);
      if (!ready.ok) return;

      const blocked = await container.workService.createWork({
        title: "Wave blocked",
        template: "feature",
        priority: "medium",
        author: "agent-wave",
        content: "## Objective\nBlocked\n\n## Acceptance Criteria\n- [ ] later",
      });
      expect(blocked.ok).toBe(true);
      if (!blocked.ok) return;

      const linked = await container.workService.addDependency(blocked.value.id, blocker.value.id);
      expect(linked.ok).toBe(true);

      const res = await fetch(url("/api/orchestration/wave"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        summary: { readyCount: number; blockedCount: number };
        ready: Array<{ workId: string; title: string; to: string }>;
        blocked: Array<{ workId: string; reason: string }>;
      };

      expect(body.summary.readyCount).toBeGreaterThanOrEqual(1);
      expect(body.ready.some((item) => item.workId === ready.value.id && item.to === "enrichment")).toBe(true);
      expect(body.blocked.some((item) => item.workId === blocked.value.id && item.reason.includes(blocker.value.id))).toBe(true);
    });
  });

  describe("POST /api/orchestration/wave/execute", () => {
    it("executes ready wave items and returns execution details", async () => {
      if (dashboardError) return;

      const created = await container.workService.createWork({
        title: "Wave execute me",
        template: "feature",
        priority: "medium",
        author: "agent-wave-exec",
        content: "## Objective\nExecute\n\n## Acceptance Criteria\n- [ ] pass",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const res = await fetch(url("/api/orchestration/wave/execute"), {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        summary: { advancedCount: number };
        advanced: Array<{ workId: string; to: string; phase: string }>;
      };

      expect(body.summary.advancedCount).toBeGreaterThanOrEqual(1);
      expect(body.advanced.some((item) => item.workId === created.value.id && item.to === "enrichment" && item.phase === "enrichment")).toBe(true);
    });
  });

  describe("GET /api/structure/graph", () => {
    it("returns derived structure nodes and edges", async () => {
      if (dashboardError) return;

      const knowledge = await container.knowledgeService.createArticle({
        title: "Graph Article",
        category: "architecture",
        content: "Graph source",
        tags: ["graph-test"],
        codeRefs: ["src/dashboard/index.ts"],
      });
      expect(knowledge.ok).toBe(true);
      if (!knowledge.ok) return;

      const work = await container.workService.createWork({
        title: "Graph Work",
        template: "feature",
        priority: "medium",
        author: "agent-graph",
        content: "## Objective\nGraph\n\n## Context\nStructure\n\n## Acceptance Criteria\n- [ ] graph\n\n## Scope\nlimited\n\n## Implementation\nbackend",
      });
      expect(work.ok).toBe(true);
      if (!work.ok) return;

      const updated = await container.workService.updateWork(work.value.id, {
        references: [knowledge.value.id],
        codeRefs: ["src/work/service.ts"],
      });
      expect(updated.ok).toBe(true);

      const res = await fetch(url("/api/structure/graph"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        nodes: Array<{ kind: string; label: string }>;
        edges: Array<{ kind: string }>;
        summary: { knowledgeCount: number; workCount: number };
      };

      expect(body.summary.knowledgeCount).toBeGreaterThanOrEqual(1);
      expect(body.summary.workCount).toBeGreaterThanOrEqual(1);
      expect(body.nodes.some((node) => node.kind === "knowledge" && node.label === "Graph Article")).toBe(true);
      expect(body.nodes.some((node) => node.kind === "work" && node.label === "Graph Work")).toBe(true);
      expect(body.edges.some((edge) => edge.kind === "reference")).toBe(true);
      expect(body.edges.some((edge) => edge.kind === "code_ref")).toBe(true);
    });
  });

  describe("GET /api/agents", () => {
    it("returns derived agent profiles and summary counts", async () => {
      if (dashboardError) return;

      const created = await container.workRepo.create({
        title: "Agents API Seed",
        template: "feature",
        phase: "review",
        priority: "medium",
        author: agentId("agent-dashboard-author"),
        assignee: agentId("agent-dashboard-impl"),
        content: "## Objective\nAgent seed\n\n## Acceptance Criteria\n- [ ] directory",
        reviewers: [{ agentId: agentId("agent-dashboard-reviewer"), status: "pending" }],
        enrichmentRoles: [{ role: "security", agentId: agentId("agent-dashboard-security"), status: "pending" }],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const event = await container.orchestrationRepo.logEvent({
        workId: created.value.id,
        eventType: "agent_spawned",
        agentId: agentId("agent-dashboard-reviewer"),
        details: { queue: "review" },
      });
      expect(event.ok).toBe(true);

      const res = await fetch(url("/api/agents"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        summary: { totalAgents: number; reviewAgents: number };
        agents: Array<{ id: string; pendingReviewCount: number; recentEvents: Array<{ direct: boolean }> }>;
      };

      expect(body.summary.totalAgents).toBeGreaterThanOrEqual(4);
      expect(body.summary.reviewAgents).toBeGreaterThanOrEqual(1);
      expect(body.agents.some((agent) => agent.id === "agent-dashboard-reviewer" && agent.pendingReviewCount === 1)).toBe(true);
      expect(body.agents.some((agent) => agent.id === "agent-dashboard-reviewer" && agent.recentEvents.some((recentEvent) => recentEvent.direct))).toBe(true);
    });
  });

  describe("GET /api/agents/:id", () => {
    it("returns 200 with the requested agent profile", async () => {
      if (dashboardError) return;

      const created = await container.workRepo.create({
        title: "Specific Agent Seed",
        template: "feature",
        priority: "medium",
        author: agentId("agent-specific-author"),
        assignee: agentId("agent-specific-assignee"),
        content: "## Objective\nSpecific\n\n## Acceptance Criteria\n- [ ] detail",
      });
      expect(created.ok).toBe(true);

      const res = await fetch(url("/api/agents/agent-specific-assignee"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; assignedCount: number };
      expect(body.id).toBe("agent-specific-assignee");
      expect(body.assignedCount).toBeGreaterThanOrEqual(1);
    });

    it("returns 404 for an unknown agent", async () => {
      if (dashboardError) return;

      const res = await fetch(url("/api/agents/does-not-exist"));
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/ingest/local", () => {
    it("imports a local markdown source into knowledge", async () => {
      if (dashboardError) return;

      await fs.mkdir(path.join(container.config.repoPath, "docs"), { recursive: true });
      await fs.writeFile(
        path.join(container.config.repoPath, "docs", "dashboard-ingest.md"),
        "# Dashboard Import\n\nImported from the dashboard.\n",
        "utf-8",
      );

      const res = await fetch(url("/api/ingest/local"), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          sourcePath: "docs/dashboard-ingest.md",
          category: "docs",
          mode: "summary",
        }),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        mode: string;
        createdCount: number;
        items: Array<{ articleId: string; sourcePath: string }>;
      };
      expect(body.mode).toBe("summary");
      expect(body.createdCount).toBe(1);
      expect(body.items[0]?.sourcePath).toBe("docs/dashboard-ingest.md");

      const knowledgeRes = await fetch(url("/api/knowledge"));
      const knowledge = (await knowledgeRes.json()) as Array<{ id: string; sourcePath?: string; title: string; content: string }>;
      const imported = knowledge.find((article) => article.id === body.items[0]?.articleId);
      expect(imported?.sourcePath).toBe("docs/dashboard-ingest.md");
      expect(imported?.content).toContain("## Summary");
    });
  });

  // ── GET /api/knowledge ────────────────────────────────────────────────────

  describe("GET /api/knowledge", () => {
    it("returns 200 with an array response", async () => {
      if (dashboardError) return;
      const res = await fetch(url("/api/knowledge"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it("returns seeded article after creation via service", async () => {
      if (dashboardError) return;
      const result = await container.knowledgeService.createArticle({
        title: "Seeded Article",
        category: "engineering",
        content: "Seeded body",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const res = await fetch(url("/api/knowledge"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ title: string; category: string; diagnostics?: { quality?: { score: number } } }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);

      const found = body.find((a) => a.title === "Seeded Article");
      expect(found).toBeDefined();
      expect(found!.category).toBe("engineering");
      expect(found!.diagnostics?.quality?.score).toBeGreaterThanOrEqual(0);
    });
  });

  describe("POST /api/knowledge", () => {
    it("creates an article and makes it searchable", async () => {
      if (dashboardError) return;

      const createRes = await fetch(url("/api/knowledge"), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          title: "Dashboard Created Article",
          category: "engineering",
          content: "This article is indexed immediately.",
          tags: ["dashboard"],
        }),
      });

      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: string; title: string };
      expect(created.title).toBe("Dashboard Created Article");

      const searchRes = await fetch(url("/api/search?q=Dashboard%20Created%20Article"));
      expect(searchRes.status).toBe(200);
      const results = (await searchRes.json()) as Array<{ id: string }>;
      expect(results.some((item) => item.id === created.id)).toBe(true);
    });
  });

  // ── GET /api/knowledge/:id ────────────────────────────────────────────────

  describe("GET /api/knowledge/:id", () => {
    it("returns 404 for non-existent ID", async () => {
      if (dashboardError) return;
      const res = await fetch(url("/api/knowledge/does-not-exist"));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });

    it("returns 200 with article for valid ID", async () => {
      if (dashboardError) return;
      const result = await container.knowledgeService.createArticle({
        title: "Fetch By ID",
        category: "architecture",
        content: "Content here",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const res = await fetch(url(`/api/knowledge/${result.value.id}`));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; title: string; diagnostics?: { freshness?: { state: string } } };
      expect(body.id).toBe(result.value.id);
      expect(body.title).toBe("Fetch By ID");
      expect(body.diagnostics?.freshness?.state).toBeTruthy();
    });
  });

  describe("PATCH /api/knowledge/:id", () => {
    it("updates an article through the dashboard API", async () => {
      if (dashboardError) return;
      const created = await container.knowledgeService.createArticle({
        title: "Knowledge Patch",
        category: "architecture",
        content: "Original",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const res = await fetch(url(`/api/knowledge/${created.value.id}`), {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ content: "Updated by dashboard" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { content: string };
      expect(body.content).toBe("Updated by dashboard");
    });
  });

  describe("DELETE /api/knowledge/:id", () => {
    it("deletes an article through the dashboard API", async () => {
      if (dashboardError) return;
      const created = await container.knowledgeService.createArticle({
        title: "Knowledge Delete",
        category: "operations",
        content: "Disposable",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const deleteRes = await fetch(url(`/api/knowledge/${created.value.id}`), {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(deleteRes.status).toBe(200);

      const getRes = await fetch(url(`/api/knowledge/${created.value.id}`));
      expect(getRes.status).toBe(404);
    });
  });

  // ── GET /api/work ─────────────────────────────────────────────────────────

  describe("GET /api/work", () => {
    it("returns 200 with array (may be empty)", async () => {
      if (dashboardError) return;
      const res = await fetch(url("/api/work"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });
  });

  describe("POST /api/work", () => {
    it("creates a work article through the dashboard API", async () => {
      if (dashboardError) return;

      const res = await fetch(url("/api/work"), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          title: "Dashboard Work Create",
          template: "feature",
          priority: "high",
          author: "agent-dashboard",
          lead: "agent-lead",
          assignee: "agent-impl",
          references: ["k-reference"],
          codeRefs: ["src/dashboard/index.ts"],
          tags: ["dashboard", "workflow"],
          content: "## Objective\nDo the work\n\n## Acceptance Criteria\n- [ ] Completed",
        }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        id: string;
        title: string;
        lead?: string;
        assignee?: string;
        references: string[];
        codeRefs: string[];
        tags: string[];
      };
      expect(body.title).toBe("Dashboard Work Create");
      expect(body.id).toBeTruthy();
      expect(body.lead).toBe("agent-lead");
      expect(body.assignee).toBe("agent-impl");
      expect(body.references).toContain("k-reference");
      expect(body.codeRefs).toContain("src/dashboard/index.ts");
      expect(body.tags).toContain("workflow");
    });
  });

  // ── GET /api/work/:id ─────────────────────────────────────────────────────

  describe("GET /api/work/:id", () => {
    it("returns 404 for non-existent ID", async () => {
      if (dashboardError) return;
      const res = await fetch(url("/api/work/does-not-exist"));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toHaveProperty("error");
    });
  });

  describe("PATCH /api/work/:id", () => {
    it("updates a work article through the dashboard API", async () => {
      if (dashboardError) return;
      const created = await container.workService.createWork({
        title: "Patch Me",
        template: "feature",
        priority: "medium",
        author: "agent-1",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const res = await fetch(url(`/api/work/${created.value.id}`), {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ assignee: "agent-owner" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { assignee: string };
      expect(body.assignee).toBe("agent-owner");
    });
  });

  describe("POST /api/work/:id/advance", () => {
    it("advances phase when guards are satisfied", async () => {
      if (dashboardError) return;
      const created = await container.workService.createWork({
        title: "Advance Me",
        template: "feature",
        priority: "medium",
        author: "agent-1",
        content: "## Objective\nShip it\n\n## Acceptance Criteria\n- [ ] Done",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const res = await fetch(url(`/api/work/${created.value.id}/advance`), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ phase: "enrichment" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { phase: string };
      expect(body.phase).toBe("enrichment");
    });

    it("rejects cancellation without reason with 400", async () => {
      if (dashboardError) return;
      const created = await container.workService.createWork({
        title: "Cancel Without Reason",
        template: "feature",
        priority: "medium",
        author: "agent-1",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const res = await fetch(url(`/api/work/${created.value.id}/advance`), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ phase: "cancelled" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("VALIDATION_FAILED");
      expect(body.message).toMatch(/reason/i);
    });

    it("accepts cancellation with reason and records it on the new phase history entry", async () => {
      if (dashboardError) return;
      const created = await container.workService.createWork({
        title: "Cancel With Reason",
        template: "feature",
        priority: "medium",
        author: "agent-1",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const res = await fetch(url(`/api/work/${created.value.id}/advance`), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ phase: "cancelled", reason: "Scope pulled by product" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { phase: string; phaseHistory: Array<{ phase: string; reason?: string }> };
      expect(body.phase).toBe("cancelled");
      const cancelEntry = body.phaseHistory.find((entry) => entry.phase === "cancelled");
      expect(cancelEntry?.reason).toBe("Scope pulled by product");
    });

    it("accepts skipGuard with reason and bypasses failing guards", async () => {
      if (dashboardError) return;
      const created = await container.workService.createWork({
        title: "Advance Without Acceptance Criteria",
        template: "feature",
        priority: "medium",
        author: "agent-1",
        content: "No structured sections — guard should fail.",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const blocked = await fetch(url(`/api/work/${created.value.id}/advance`), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ phase: "enrichment" }),
      });
      expect(blocked.status).toBe(422);
      const blockedBody = (await blocked.json()) as { error: string };
      expect(blockedBody.error).toBe("GUARD_FAILED");

      const res = await fetch(url(`/api/work/${created.value.id}/advance`), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          phase: "enrichment",
          skipGuard: { reason: "Emergency hotfix tracked in INC-4821" },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { phase: string; phaseHistory: Array<{ phase: string; skippedGuards?: string[]; reason?: string }> };
      expect(body.phase).toBe("enrichment");
      const enrichEntry = body.phaseHistory.find((entry) => entry.phase === "enrichment");
      expect(enrichEntry?.skippedGuards?.length).toBeGreaterThan(0);
      expect(enrichEntry?.reason).toBe("Emergency hotfix tracked in INC-4821");
    });

    it("rejects skipGuard without reason with 400", async () => {
      if (dashboardError) return;
      const created = await container.workService.createWork({
        title: "SkipGuard Missing Reason",
        template: "feature",
        priority: "medium",
        author: "agent-1",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const res = await fetch(url(`/api/work/${created.value.id}/advance`), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ phase: "enrichment", skipGuard: {} }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("VALIDATION_FAILED");
      expect(body.message).toMatch(/skipGuard/i);
    });
  });

  describe("/api/work/:id/dependencies", () => {
    it("adds and removes blocker relationships through the dashboard API", async () => {
      if (dashboardError) return;

      const blocker = await container.workService.createWork({
        title: "Dependency Blocker",
        template: "bugfix",
        priority: "medium",
        author: "agent-blocker",
      });
      expect(blocker.ok).toBe(true);
      if (!blocker.ok) return;

      const dependent = await container.workService.createWork({
        title: "Dependency Dependent",
        template: "feature",
        priority: "medium",
        author: "agent-dependent",
      });
      expect(dependent.ok).toBe(true);
      if (!dependent.ok) return;

      const addRes = await fetch(url(`/api/work/${dependent.value.id}/dependencies`), {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ blockedById: blocker.value.id }),
      });
      expect(addRes.status).toBe(200);
      const added = (await addRes.json()) as { blockedBy: string[] };
      expect(added.blockedBy).toContain(blocker.value.id);

      const removeRes = await fetch(url(`/api/work/${dependent.value.id}/dependencies?blockedById=${encodeURIComponent(blocker.value.id)}`), {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(removeRes.status).toBe(200);
      const removed = (await removeRes.json()) as { blockedBy: string[] };
      expect(removed.blockedBy).not.toContain(blocker.value.id);
    });
  });

  // ── GET /api/search ───────────────────────────────────────────────────────

  describe("GET /api/search?q=test", () => {
    it("returns 200 with results array", async () => {
      if (dashboardError) return;
      const created = await container.knowledgeService.createArticle({
        title: "Search diagnostics article",
        category: "architecture",
        content: "Search diagnostics content",
        codeRefs: ["src/dashboard/index.ts"],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const res = await fetch(url("/api/search?q=test"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it("returns enriched metadata and diagnostics", async () => {
      if (dashboardError) return;
      const created = await container.knowledgeService.createArticle({
        title: "API Search Enrichment",
        category: "architecture",
        content: "Search enrichment content",
        codeRefs: ["src/search/service.ts"],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const res = await fetch(url("/api/search?q=enrichment"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{
        id: string;
        category?: string;
        diagnostics?: { quality?: { score: number } };
      }>;
      const found = body.find((item) => item.id === created.value.id);
      expect(found?.category).toBe("architecture");
      expect(found?.diagnostics?.quality?.score).toBeGreaterThan(0);
    });
  });

  describe("GET /api/search/context-pack", () => {
    it("returns a ranked context pack for code mode", async () => {
      if (dashboardError) return;
      const created = await container.knowledgeService.createArticle({
        title: "Context Pack Architecture",
        category: "architecture",
        content: "Pack content about auth and routing.",
        codeRefs: ["src/auth/service.ts", "src/auth/router.ts"],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const res = await fetch(url("/api/search/context-pack?q=auth&mode=code"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        mode: string;
        summary: { itemCount: number };
        items: Array<{ id: string; diagnostics?: { freshness?: { state: string } } }>;
      };
      expect(body.mode).toBe("code");
      expect(body.summary.itemCount).toBeGreaterThanOrEqual(1);
      expect(body.items.some((item) => item.id === created.value.id)).toBe(true);
      expect(body.items[0]?.diagnostics?.freshness?.state).toBeTruthy();
    });
  });

  describe("POST /api/search/reindex", () => {
    it("rebuilds the index and records freshness stats", async () => {
      if (dashboardError) return;
      const res = await fetch(url("/api/search/reindex"), { method: "POST", headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { knowledgeCount: number; workCount: number };
      expect(body.knowledgeCount).toBeGreaterThanOrEqual(0);
      expect(body.workCount).toBeGreaterThanOrEqual(0);

      const statusRes = await fetch(url("/api/status"));
      const statusBody = (await statusRes.json()) as { stats?: { lastReindexAt?: string } };
      expect(statusBody.stats?.lastReindexAt).toBeTruthy();
    });
  });

  // ── Unknown route ─────────────────────────────────────────────────────────

  describe("unknown route", () => {
    it("GET /api/unknown returns 404", async () => {
      if (dashboardError) return;
      const res = await fetch(url("/api/unknown"));
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toHaveProperty("error", "NOT_FOUND");
    });
  });

  // ── Method not allowed ────────────────────────────────────────────────────

  describe("method not allowed", () => {
    it("POST /api/status returns 405", async () => {
      if (dashboardError) return;
      const res = await fetch(url("/api/status"), { method: "POST" });
      expect(res.status).toBe(405);
      const body = await res.json();
      expect(body).toHaveProperty("error", "METHOD_NOT_ALLOWED");
    });
  });

  // ── CORS ──────────────────────────────────────────────────────────────────

  describe("CORS", () => {
    it("response includes Access-Control-Allow-Origin header", async () => {
      if (dashboardError) return;
      const res = await fetch(url("/api/status"));
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("OPTIONS request returns CORS preflight headers", async () => {
      if (dashboardError) return;
      const res = await fetch(url("/api/status"), { method: "OPTIONS" });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    });
  });
});

// ─── Static file serving ───────────────────────────────────────────────────

describe("Static file serving", () => {
  it("GET / serves index.html with text/html", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    const body = await res.text();
    expect(body).toContain("SPA Shell");
  });

  it("GET /test.css serves CSS with correct MIME type", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/test.css"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/css");
    const body = await res.text();
    expect(body).toContain("color: red");
  });

  it("GET /test.js serves JS with correct MIME type", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/test.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    const body = await res.text();
    expect(body).toContain("console.log");
  });

  it("GET /nonexistent.js returns 404 (not HTML)", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/nonexistent.js"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toContain("Asset not found");
  });

  it("GET /missing.css returns 404 (not HTML)", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/missing.css"));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("GET /flow serves index.html (SPA fallback)", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/flow"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    const body = await res.text();
    expect(body).toContain("SPA Shell");
  });

  it("GET /knowledge/graph serves index.html (SPA fallback for nested route)", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/knowledge/graph"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    const body = await res.text();
    expect(body).toContain("SPA Shell");
  });

  it("rejects directory traversal attempts", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/../package.json"));
    // Should either be 400 (bad request) or not serve the real file
    const body = await res.text();
    expect(body).not.toContain("monsthera");
  });

  it("API routes still return JSON when static serving is active", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/api/status"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = await res.json();
    expect(body).toHaveProperty("version", VERSION);
  });
});
