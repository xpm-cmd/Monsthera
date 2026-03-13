import { describe, expect, it } from "vitest";
import {
  shouldAutoTriage,
  shouldAutoClose,
  shouldAutoReview,
  shouldAutoUnblock,
} from "../../../src/tickets/lifecycle-rules.js";
import { TicketLifecycleReactor } from "../../../src/tickets/lifecycle.js";
import type { LifecycleConfig } from "../../../src/core/config.js";

const BASE_CONFIG: LifecycleConfig = {
  enabled: true,
  autoTriageOnCreate: true,
  autoTriageSeverityThreshold: "medium",
  autoTriagePriorityThreshold: 5,
  autoCloseResolvedAfterMs: 259_200_000, // 72h
  autoReviewOnPatch: true,
  autoCascadeBlocked: true,
  sweepIntervalMs: 60_000,
};

// ─── shouldAutoTriage ────────────────────────────────────────

describe("shouldAutoTriage", () => {
  it("fires for high severity above priority threshold", () => {
    const result = shouldAutoTriage(
      { status: "backlog", severity: "high", priority: 8 },
      BASE_CONFIG,
    );
    expect(result.shouldFire).toBe(true);
    expect(result.targetStatus).toBe("technical_analysis");
    expect(result.reason).toContain("severity=high");
  });

  it("fires for critical severity at exact priority threshold", () => {
    const result = shouldAutoTriage(
      { status: "backlog", severity: "critical", priority: 5 },
      BASE_CONFIG,
    );
    expect(result.shouldFire).toBe(true);
  });

  it("fires for medium severity (equal to threshold)", () => {
    const result = shouldAutoTriage(
      { status: "backlog", severity: "medium", priority: 5 },
      BASE_CONFIG,
    );
    expect(result.shouldFire).toBe(true);
  });

  it("skips for low severity (below threshold)", () => {
    const result = shouldAutoTriage(
      { status: "backlog", severity: "low", priority: 8 },
      BASE_CONFIG,
    );
    expect(result.shouldFire).toBe(false);
  });

  it("skips for priority below threshold", () => {
    const result = shouldAutoTriage(
      { status: "backlog", severity: "high", priority: 3 },
      BASE_CONFIG,
    );
    expect(result.shouldFire).toBe(false);
  });

  it("skips when autoTriageOnCreate is false", () => {
    const result = shouldAutoTriage(
      { status: "backlog", severity: "critical", priority: 10 },
      { ...BASE_CONFIG, autoTriageOnCreate: false },
    );
    expect(result.shouldFire).toBe(false);
  });

  it("skips for non-backlog tickets", () => {
    const result = shouldAutoTriage(
      { status: "technical_analysis", severity: "high", priority: 8 },
      BASE_CONFIG,
    );
    expect(result.shouldFire).toBe(false);
  });

  it("respects high severity threshold (only critical passes)", () => {
    const config = { ...BASE_CONFIG, autoTriageSeverityThreshold: "high" as const };
    expect(shouldAutoTriage({ status: "backlog", severity: "critical", priority: 5 }, config).shouldFire).toBe(true);
    expect(shouldAutoTriage({ status: "backlog", severity: "high", priority: 5 }, config).shouldFire).toBe(true);
    expect(shouldAutoTriage({ status: "backlog", severity: "medium", priority: 5 }, config).shouldFire).toBe(false);
  });
});

// ─── shouldAutoClose ─────────────────────────────────────────

describe("shouldAutoClose", () => {
  const now = Date.now();

  it("fires when resolved ticket exceeds age threshold", () => {
    const updatedAt = new Date(now - 300_000_000).toISOString(); // ~83h ago
    const result = shouldAutoClose(
      { status: "resolved", updatedAt },
      BASE_CONFIG,
      now,
    );
    expect(result.shouldFire).toBe(true);
    expect(result.targetStatus).toBe("closed");
    expect(result.reason).toContain("Auto-closed");
  });

  it("skips when resolved ticket is below age threshold", () => {
    const updatedAt = new Date(now - 100_000_000).toISOString(); // ~28h ago
    const result = shouldAutoClose(
      { status: "resolved", updatedAt },
      BASE_CONFIG,
      now,
    );
    expect(result.shouldFire).toBe(false);
  });

  it("skips when autoCloseResolvedAfterMs is 0 (disabled)", () => {
    const updatedAt = new Date(now - 999_999_999).toISOString();
    const result = shouldAutoClose(
      { status: "resolved", updatedAt },
      { ...BASE_CONFIG, autoCloseResolvedAfterMs: 0 },
      now,
    );
    expect(result.shouldFire).toBe(false);
  });

  it("skips for non-resolved tickets", () => {
    const updatedAt = new Date(now - 999_999_999).toISOString();
    const result = shouldAutoClose(
      { status: "in_progress", updatedAt },
      BASE_CONFIG,
      now,
    );
    expect(result.shouldFire).toBe(false);
  });
});

// ─── shouldAutoReview ────────────────────────────────────────

describe("shouldAutoReview", () => {
  it("fires when in_progress ticket gets a validated patch", () => {
    const result = shouldAutoReview(
      { status: "in_progress" },
      "validated",
      BASE_CONFIG,
    );
    expect(result.shouldFire).toBe(true);
    expect(result.targetStatus).toBe("in_review");
  });

  it("skips for stale patches", () => {
    const result = shouldAutoReview(
      { status: "in_progress" },
      "stale",
      BASE_CONFIG,
    );
    expect(result.shouldFire).toBe(false);
  });

  it("skips when ticket is not in_progress", () => {
    const result = shouldAutoReview(
      { status: "approved" },
      "validated",
      BASE_CONFIG,
    );
    expect(result.shouldFire).toBe(false);
  });

  it("skips when autoReviewOnPatch is false", () => {
    const result = shouldAutoReview(
      { status: "in_progress" },
      "validated",
      { ...BASE_CONFIG, autoReviewOnPatch: false },
    );
    expect(result.shouldFire).toBe(false);
  });
});

// ─── shouldAutoUnblock ───────────────────────────────────────

describe("shouldAutoUnblock", () => {
  it("fires when all blockers are in terminal state and was lifecycle-blocked", () => {
    const result = shouldAutoUnblock(
      { status: "blocked" },
      ["resolved", "closed"],
      BASE_CONFIG,
      true,
    );
    expect(result.shouldFire).toBe(true);
    expect(result.targetStatus).toBe("in_progress");
    expect(result.reason).toContain("2 blocking tickets");
  });

  it("skips when a blocker is not in terminal state", () => {
    const result = shouldAutoUnblock(
      { status: "blocked" },
      ["resolved", "in_progress"],
      BASE_CONFIG,
      true,
    );
    expect(result.shouldFire).toBe(false);
  });

  it("skips when ticket is not blocked", () => {
    const result = shouldAutoUnblock(
      { status: "in_progress" },
      ["resolved"],
      BASE_CONFIG,
      true,
    );
    expect(result.shouldFire).toBe(false);
  });

  it("skips when no blockers exist", () => {
    const result = shouldAutoUnblock(
      { status: "blocked" },
      [],
      BASE_CONFIG,
      true,
    );
    expect(result.shouldFire).toBe(false);
  });

  it("skips when autoCascadeBlocked is false", () => {
    const result = shouldAutoUnblock(
      { status: "blocked" },
      ["resolved"],
      { ...BASE_CONFIG, autoCascadeBlocked: false },
      true,
    );
    expect(result.shouldFire).toBe(false);
  });

  it("skips provenance guard: not lifecycle-blocked", () => {
    const result = shouldAutoUnblock(
      { status: "blocked" },
      ["resolved"],
      BASE_CONFIG,
      false,
    );
    expect(result.shouldFire).toBe(false);
  });

  it("fires for wont_fix terminal state", () => {
    const result = shouldAutoUnblock(
      { status: "blocked" },
      ["wont_fix"],
      BASE_CONFIG,
      true,
    );
    expect(result.shouldFire).toBe(true);
  });
});

// ─── Reactor: isLifecycleActor (loop guard) ─────────────────

describe("isLifecycleActor loop guard", () => {
  // Access private method via prototype for testing
  const isLifecycleActor = (actorLabel?: string) => {
    return (TicketLifecycleReactor.prototype as any).isLifecycleActor.call(
      {},
      { actorLabel },
    );
  };

  it("recognizes raw lifecycle- prefix", () => {
    expect(isLifecycleActor("lifecycle-auto-triage")).toBe(true);
    expect(isLifecycleActor("lifecycle-auto-close")).toBe(true);
    expect(isLifecycleActor("lifecycle-auto-unblock")).toBe(true);
  });

  it("recognizes system:lifecycle- prefix (resolved actor ID)", () => {
    expect(isLifecycleActor("system:lifecycle-auto-triage")).toBe(true);
    expect(isLifecycleActor("system:lifecycle-auto-close")).toBe(true);
    expect(isLifecycleActor("system:lifecycle-auto-review")).toBe(true);
  });

  it("rejects non-lifecycle actors", () => {
    expect(isLifecycleActor("agent-abc123")).toBe(false);
    expect(isLifecycleActor("system:council-auto-advance")).toBe(false);
    expect(isLifecycleActor(undefined)).toBe(false);
  });
});
