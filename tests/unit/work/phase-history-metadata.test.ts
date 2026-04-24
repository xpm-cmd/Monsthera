import { describe, it, expect } from "vitest";
import { WorkPhase, timestamp } from "../../../src/core/types.js";
import {
  buildAdvanceHistoryEntry,
  buildCancellationHistoryEntry,
} from "../../../src/work/phase-history.js";

describe("buildAdvanceHistoryEntry (metadata)", () => {
  it("omits metadata when none is supplied", () => {
    const entry = buildAdvanceHistoryEntry(
      WorkPhase.ENRICHMENT,
      timestamp("2026-04-24T00:00:00.000Z"),
      undefined,
      [],
    );
    expect(entry.metadata).toBeUndefined();
  });

  it("persists a structured metadata object", () => {
    const entry = buildAdvanceHistoryEntry(
      WorkPhase.IMPLEMENTATION,
      timestamp("2026-04-24T00:00:00.000Z"),
      {
        metadata: {
          success_test: "Y",
          blockers: 0,
          verdicts: ["adopt-v1", "monitor"],
          verify_count: 2,
        },
      },
      [],
    );
    expect(entry.metadata).toEqual({
      success_test: "Y",
      blockers: 0,
      verdicts: ["adopt-v1", "monitor"],
      verify_count: 2,
    });
  });

  it("treats an empty metadata object as absent", () => {
    const entry = buildAdvanceHistoryEntry(
      WorkPhase.ENRICHMENT,
      timestamp("2026-04-24T00:00:00.000Z"),
      { metadata: {} },
      [],
    );
    expect(entry.metadata).toBeUndefined();
  });

  it("carries metadata alongside skipGuard data", () => {
    const entry = buildAdvanceHistoryEntry(
      WorkPhase.DONE,
      timestamp("2026-04-24T00:00:00.000Z"),
      {
        skipGuard: { reason: "no reviewer" },
        metadata: { success_test: "N", blockers: 1 },
      },
      ["all_reviewers_approved"],
    );
    expect(entry.reason).toBe("no reviewer");
    expect(entry.skippedGuards).toEqual(["all_reviewers_approved"]);
    expect(entry.metadata).toEqual({ success_test: "N", blockers: 1 });
  });

  it("defensive copies so later caller mutations don't leak in", () => {
    const raw = { blockers: 2 };
    const entry = buildAdvanceHistoryEntry(
      WorkPhase.ENRICHMENT,
      timestamp("2026-04-24T00:00:00.000Z"),
      { metadata: raw },
      [],
    );
    raw.blockers = 999;
    expect(entry.metadata).toEqual({ blockers: 2 });
  });
});

describe("buildCancellationHistoryEntry (metadata)", () => {
  it("carries metadata on a cancellation entry", () => {
    const entry = buildCancellationHistoryEntry(
      WorkPhase.CANCELLED,
      timestamp("2026-04-24T00:00:00.000Z"),
      { reason: "scope changed", metadata: { fabrications: 0, verify_count: 1 } },
      [],
    );
    expect(entry.reason).toBe("scope changed");
    expect(entry.metadata).toEqual({ fabrications: 0, verify_count: 1 });
  });
});
