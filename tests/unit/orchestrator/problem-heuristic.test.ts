import { describe, it, expect } from "vitest";
import { resolveProblem, type ProblemContext } from "../../../src/orchestrator/problem-heuristic.js";

function buildContext(overrides: Partial<ProblemContext> = {}): ProblemContext {
  return {
    retriesRemaining: 1,
    waveTicketCount: 4,
    completedTicketCount: 0,
    conflictHistory: [],
    ...overrides,
  };
}

describe("resolveProblem", () => {
  // ── Conflict ──

  it("conflict: first time + retries remaining → retry", () => {
    const result = resolveProblem(
      { kind: "conflict", ticketId: "TKT-1", conflicts: ["src/a.ts"] },
      buildContext({ retriesRemaining: 1 }),
    );
    expect(result.action).toBe("retry");
  });

  it("conflict: first time + 0 retries → skip", () => {
    const result = resolveProblem(
      { kind: "conflict", ticketId: "TKT-1", conflicts: ["src/a.ts"] },
      buildContext({ retriesRemaining: 0 }),
    );
    expect(result.action).toBe("skip");
  });

  it("conflict: in history (repeat) → skip regardless of retries", () => {
    const result = resolveProblem(
      { kind: "conflict", ticketId: "TKT-1", conflicts: ["src/a.ts"] },
      buildContext({ retriesRemaining: 3, conflictHistory: ["TKT-1"] }),
    );
    expect(result.action).toBe("skip");
  });

  // ── Test Failure ──

  it("test_failure: has culprit → skip", () => {
    const result = resolveProblem(
      { kind: "test_failure", ticketId: "TKT-1", culprit: "TKT-1" },
      buildContext(),
    );
    expect(result.action).toBe("skip");
  });

  it("test_failure: no culprit + >=50% complete → skip", () => {
    const result = resolveProblem(
      { kind: "test_failure", ticketId: "unknown", culprit: null },
      buildContext({ waveTicketCount: 4, completedTicketCount: 2 }),
    );
    expect(result.action).toBe("skip");
  });

  it("test_failure: no culprit + <50% complete → abort", () => {
    const result = resolveProblem(
      { kind: "test_failure", ticketId: "unknown", culprit: null },
      buildContext({ waveTicketCount: 4, completedTicketCount: 1 }),
    );
    expect(result.action).toBe("abort");
  });

  // ── Timeout ──

  it("timeout: always skip", () => {
    const result = resolveProblem(
      { kind: "timeout", ticketId: "TKT-1", elapsedMs: 60000 },
      buildContext({ retriesRemaining: 5 }),
    );
    expect(result.action).toBe("skip");
  });

  // ── Spawn Failure ──

  it("spawn_failure: retries remaining → retry", () => {
    const result = resolveProblem(
      { kind: "spawn_failure", ticketId: "TKT-1", error: "ENOMEM" },
      buildContext({ retriesRemaining: 2 }),
    );
    expect(result.action).toBe("retry");
  });

  it("spawn_failure: 0 retries → skip", () => {
    const result = resolveProblem(
      { kind: "spawn_failure", ticketId: "TKT-1", error: "ENOMEM" },
      buildContext({ retriesRemaining: 0 }),
    );
    expect(result.action).toBe("skip");
  });

  // ── Context accumulation ──

  it("conflict → retry → conflict again → skip (via conflictHistory)", () => {
    // First conflict: retry
    const first = resolveProblem(
      { kind: "conflict", ticketId: "TKT-1", conflicts: ["src/a.ts"] },
      buildContext({ retriesRemaining: 1, conflictHistory: [] }),
    );
    expect(first.action).toBe("retry");

    // Second conflict (same ticket in history): skip
    const second = resolveProblem(
      { kind: "conflict", ticketId: "TKT-1", conflicts: ["src/a.ts"] },
      buildContext({ retriesRemaining: 0, conflictHistory: ["TKT-1"] }),
    );
    expect(second.action).toBe("skip");
  });

  // ── Edge cases ──

  it("test_failure: no culprit + 0 wave tickets → skip (safe division)", () => {
    const result = resolveProblem(
      { kind: "test_failure", ticketId: "unknown", culprit: null },
      buildContext({ waveTicketCount: 0, completedTicketCount: 0 }),
    );
    // 0/max(0,1) = 0 < 0.5 → abort
    expect(result.action).toBe("abort");
  });
});
