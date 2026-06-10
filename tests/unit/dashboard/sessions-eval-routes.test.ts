import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { startDashboard } from "../../../src/dashboard/index.js";
import type { DashboardServer } from "../../../src/dashboard/index.js";
import { createTestContainer } from "../../../src/core/container.js";
import type { MonstheraContainer } from "../../../src/core/container.js";
import { agentId } from "../../../src/core/types.js";

/**
 * Wave D2 — the two new read surfaces behind the dashboard:
 *  - /api/sessions + /api/sessions/:id (the v3 flagship feature finally
 *    gets a visual surface; list + detail, GET-only)
 *  - /api/system/eval (engine + committed eval baseline; 404s cleanly in
 *    consumer repos that have no tests/eval/baseline.json)
 */

describe("sessions and system/eval routes", () => {
  let container: MonstheraContainer;
  let dashboard: DashboardServer | undefined;
  let boot: NodeJS.ErrnoException | undefined;

  beforeAll(async () => {
    try {
      container = await createTestContainer();
      dashboard = await startDashboard(container, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        boot = error as NodeJS.ErrnoException;
        return;
      }
      throw error;
    }
  });

  afterAll(async () => {
    if (dashboard) await dashboard.close();
    if (container) await container.dispose();
  });

  function url(p: string): string {
    if (boot || !dashboard) return "http://127.0.0.1/unavailable";
    return `http://localhost:${dashboard.port}${p}`;
  }

  function authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${dashboard?.authToken ?? ""}` };
  }

  it("GET /api/sessions returns the session list (newest first)", async () => {
    if (boot) return;

    const opened = await container.sessionService.open({
      agentId: agentId("agent-d2"),
      repo: "/tmp/d2-repo",
      branch: "main",
      intent: "dashboard sessions surface",
    });
    expect(opened.ok).toBe(true);

    const res = await fetch(url("/api/sessions"), { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ id: string; agentId: string; status: string }> };
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.length).toBeGreaterThan(0);
    expect(body.sessions[0]).toMatchObject({ agentId: agentId("agent-d2"), status: "open" });
  });

  it("GET /api/sessions/:id returns the full session; unknown id is 404", async () => {
    if (boot) return;

    const opened = await container.sessionService.open({
      agentId: agentId("agent-d2-detail"),
      repo: "/tmp/d2-repo",
      branch: null,
      intent: null,
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const id = opened.value.session.id;

    const res = await fetch(url(`/api/sessions/${id}`), { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; agentId: string };
    expect(body.id).toBe(id);
    expect(body.agentId).toBe("agent-d2-detail");

    const missing = await fetch(url("/api/sessions/ses-nope"), { headers: authHeaders() });
    expect(missing.status).toBe(404);
  });

  it("non-GET methods on /api/sessions are 405", async () => {
    if (boot) return;
    const res = await fetch(url("/api/sessions"), { method: "POST", headers: authHeaders() });
    expect(res.status).toBe(405);
  });

  it("GET /api/system/eval serves the committed baseline when present, 404 when absent", async () => {
    if (boot) return;

    // Absent in a fresh test container repo → clean 404, not a crash.
    const missing = await fetch(url("/api/system/eval"), { headers: authHeaders() });
    expect(missing.status).toBe(404);

    // Write a baseline fixture into the container's repo and re-request.
    const baselineDir = path.join(container.config.repoPath, "tests", "eval");
    await fs.mkdir(baselineDir, { recursive: true });
    await fs.writeFile(
      path.join(baselineDir, "baseline.json"),
      JSON.stringify({
        target: "pack",
        k: 10,
        caseCount: 28,
        engine: "semantic",
        aggregate: { precisionAtK: 0.19, recallAtK: 0.99, ndcgAtK: 0.9, mrr: 0.89, contaminationRate: 0.72 },
      }),
      "utf-8",
    );

    const res = await fetch(url("/api/system/eval"), { headers: authHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      baseline: { engine: string; caseCount: number; aggregate: { ndcgAtK: number } };
      live: { semanticEnabled: boolean };
    };
    expect(body.baseline.engine).toBe("semantic");
    expect(body.baseline.aggregate.ndcgAtK).toBe(0.9);
    expect(typeof body.live.semanticEnabled).toBe("boolean");
  });
});
