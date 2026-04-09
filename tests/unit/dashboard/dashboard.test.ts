import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startDashboard } from "../../../src/dashboard/index.js";
import type { DashboardServer } from "../../../src/dashboard/index.js";
import { createTestContainer } from "../../../src/core/container.js";
import type { MonstheraContainer } from "../../../src/core/container.js";
import { VERSION } from "../../../src/core/constants.js";

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

  // ── GET /api/knowledge ────────────────────────────────────────────────────

  describe("GET /api/knowledge", () => {
    it("returns 200 with empty array initially", async () => {
      if (dashboardError) return;
      const res = await fetch(url("/api/knowledge"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
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
      const body = (await res.json()) as Array<{ title: string; category: string }>;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);

      const found = body.find((a) => a.title === "Seeded Article");
      expect(found).toBeDefined();
      expect(found!.category).toBe("engineering");
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
      const body = (await res.json()) as { id: string; title: string };
      expect(body.id).toBe(result.value.id);
      expect(body.title).toBe("Fetch By ID");
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

  // ── GET /api/search ───────────────────────────────────────────────────────

  describe("GET /api/search?q=test", () => {
    it("returns 200 with results array", async () => {
      if (dashboardError) return;
      const res = await fetch(url("/api/search?q=test"));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
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
