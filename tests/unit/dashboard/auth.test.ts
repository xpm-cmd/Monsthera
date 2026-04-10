import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { requireAuth, generateToken } from "../../../src/dashboard/auth.js";
import { startDashboard } from "../../../src/dashboard/index.js";
import type { DashboardServer } from "../../../src/dashboard/index.js";
import { createTestContainer } from "../../../src/core/container.js";
import type { MonstheraContainer } from "../../../src/core/container.js";
import type { IncomingMessage } from "node:http";

// ─── Unit tests for requireAuth ─────────────────────────────────────────────

function fakeReq(method: string, authorization?: string): IncomingMessage {
  return {
    method,
    headers: authorization ? { authorization } : {},
  } as unknown as IncomingMessage;
}

describe("requireAuth", () => {
  const token = "abc123def456";

  it("allows GET requests without a token", () => {
    expect(requireAuth(fakeReq("GET"), token, "/api/knowledge")).toBe(true);
  });

  it("allows OPTIONS requests without a token", () => {
    expect(requireAuth(fakeReq("OPTIONS"), token, "/api/knowledge")).toBe(true);
  });

  it("allows POST to exempt paths without a token", () => {
    expect(requireAuth(fakeReq("POST"), token, "/api/health")).toBe(true);
    expect(requireAuth(fakeReq("POST"), token, "/api/status")).toBe(true);
  });

  it("rejects POST without Authorization header", () => {
    expect(requireAuth(fakeReq("POST"), token, "/api/knowledge")).toBe(false);
  });

  it("rejects POST with wrong token", () => {
    expect(requireAuth(fakeReq("POST", "Bearer wrong-token"), token, "/api/knowledge")).toBe(false);
  });

  it("rejects POST with malformed Authorization header", () => {
    expect(requireAuth(fakeReq("POST", "Basic abc123"), token, "/api/knowledge")).toBe(false);
  });

  it("accepts POST with correct Bearer token", () => {
    expect(requireAuth(fakeReq("POST", `Bearer ${token}`), token, "/api/knowledge")).toBe(true);
  });

  it("rejects token with different length", () => {
    expect(requireAuth(fakeReq("POST", "Bearer short"), token, "/api/knowledge")).toBe(false);
  });

  it("rejects DELETE without token", () => {
    expect(requireAuth(fakeReq("DELETE"), token, "/api/knowledge/k-123")).toBe(false);
  });

  it("rejects PATCH without token", () => {
    expect(requireAuth(fakeReq("PATCH"), token, "/api/work/w-123")).toBe(false);
  });
});

describe("generateToken", () => {
  it("returns a 64-char hex string", () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates unique tokens", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});

// ─── Integration: dashboard rejects unauthenticated mutations ───────────────

describe("Dashboard auth integration", () => {
  let container: MonstheraContainer;
  let dashboard: DashboardServer | undefined;
  let dashboardError: NodeJS.ErrnoException | undefined;

  beforeAll(async () => {
    try {
      container = await createTestContainer();
      dashboard = await startDashboard(container, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        dashboardError = error as NodeJS.ErrnoException;
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
    if (dashboardError || !dashboard) return "http://127.0.0.1/unavailable";
    return `http://localhost:${dashboard.port}${p}`;
  }

  it("POST /api/knowledge without token returns 401", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/api/knowledge"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Unauthorized", category: "test", content: "nope" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("UNAUTHORIZED");
  });

  it("POST /api/knowledge with wrong token returns 401", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/api/knowledge"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-token-value",
      },
      body: JSON.stringify({ title: "Wrong token", category: "test", content: "nope" }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/knowledge with valid token succeeds", async () => {
    if (dashboardError || !dashboard) return;
    const res = await fetch(url("/api/knowledge"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${dashboard.authToken}`,
      },
      body: JSON.stringify({
        title: "Auth Test Article",
        category: "test",
        content: "Created with valid auth.",
      }),
    });
    expect(res.status).toBe(201);
  });

  it("GET /api/health without token returns 200 (exempt)", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/api/health"));
    expect(res.status).toBe(200);
  });

  it("GET /api/knowledge without token returns 200 (GET is exempt)", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/api/knowledge"));
    expect(res.status).toBe(200);
  });

  it("DELETE /api/knowledge/:id without token returns 401", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/api/knowledge/k-nonexistent"), {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("CORS preflight includes Authorization in allowed headers", async () => {
    if (dashboardError) return;
    const res = await fetch(url("/api/knowledge"), { method: "OPTIONS" });
    expect(res.status).toBe(204);
    const allowed = res.headers.get("access-control-allow-headers");
    expect(allowed).toContain("Authorization");
  });
});
