import { describe, it, expect } from "vitest";
import {
  computeWaves,
  preflightWorkGroup,
  getReadyTickets,
  type WavePlan,
} from "../../../src/waves/scheduler.js";

// ---------------------------------------------------------------------------
// computeWaves
// ---------------------------------------------------------------------------

describe("computeWaves", () => {
  it("linear chain: 4 tickets A→B→C→D produces 4 waves of 1 each", () => {
    const result = computeWaves(
      ["A", "B", "C", "D"],
      [
        { blocker: "A", blocked: "B" },
        { blocker: "B", blocked: "C" },
        { blocker: "C", blocked: "D" },
      ],
    );

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    expect(plan.waveCount).toBe(4);
    expect(plan.waves[0]).toEqual(["A"]);
    expect(plan.waves[1]).toEqual(["B"]);
    expect(plan.waves[2]).toEqual(["C"]);
    expect(plan.waves[3]).toEqual(["D"]);
  });

  it("diamond DAG: A blocks B and C, both block D → 3 waves", () => {
    const result = computeWaves(
      ["A", "B", "C", "D"],
      [
        { blocker: "A", blocked: "B" },
        { blocker: "A", blocked: "C" },
        { blocker: "B", blocked: "D" },
        { blocker: "C", blocked: "D" },
      ],
    );

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    expect(plan.waveCount).toBe(3);
    expect(plan.waves[0]).toEqual(["A"]);
    expect(plan.waves[1]).toEqual(expect.arrayContaining(["B", "C"]));
    expect(plan.waves[1]).toHaveLength(2);
    expect(plan.waves[2]).toEqual(["D"]);
  });

  it("disconnected graph: 4 tickets with no deps → all in wave 0", () => {
    const result = computeWaves(["A", "B", "C", "D"], []);

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    expect(plan.waveCount).toBe(1);
    expect(plan.waves[0]).toEqual(expect.arrayContaining(["A", "B", "C", "D"]));
    expect(plan.waves[0]).toHaveLength(4);
  });

  it("cycle detection: A blocks B, B blocks A → returns error", () => {
    const result = computeWaves(
      ["A", "B"],
      [
        { blocker: "A", blocked: "B" },
        { blocker: "B", blocked: "A" },
      ],
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("cycle");
      expect(result.cycleTicketIds).toEqual(expect.arrayContaining(["A", "B"]));
    }
  });

  it("single ticket → 1 wave of 1", () => {
    const result = computeWaves(["A"], []);

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    expect(plan.waveCount).toBe(1);
    expect(plan.waves[0]).toEqual(["A"]);
  });

  it("wide fan-out: A blocks B,C,D,E → 2 waves", () => {
    const result = computeWaves(
      ["A", "B", "C", "D", "E"],
      [
        { blocker: "A", blocked: "B" },
        { blocker: "A", blocked: "C" },
        { blocker: "A", blocked: "D" },
        { blocker: "A", blocked: "E" },
      ],
    );

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    expect(plan.waveCount).toBe(2);
    expect(plan.waves[0]).toEqual(["A"]);
    expect(plan.waves[1]).toEqual(expect.arrayContaining(["B", "C", "D", "E"]));
    expect(plan.waves[1]).toHaveLength(4);
  });

  it("no edges (empty blocksEdges) → all in wave 0", () => {
    const result = computeWaves(["X", "Y", "Z"], []);

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    expect(plan.waveCount).toBe(1);
    expect(plan.waves[0]).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// preflightWorkGroup
// ---------------------------------------------------------------------------

describe("preflightWorkGroup", () => {
  it("detects file overlaps within same wave", () => {
    const tickets = [
      { ticketId: "A", affectedPaths: ["src/utils.ts"] },
      { ticketId: "B", affectedPaths: ["src/utils.ts"] },
    ];
    // No deps → both in wave 0
    const result = preflightWorkGroup(tickets, []);

    expect(result.valid).toBe(true);
    expect(result.fileOverlapWarnings).toHaveLength(1);
    expect(result.fileOverlapWarnings[0]).toEqual(
      expect.objectContaining({
        wave: 0,
        ticketA: "A",
        ticketB: "B",
      }),
    );
    expect(result.fileOverlapWarnings[0]!.overlappingPaths).toContain("src/utils.ts");
  });

  it("no warnings across waves", () => {
    const tickets = [
      { ticketId: "A", affectedPaths: ["src/utils.ts"] },
      { ticketId: "B", affectedPaths: ["src/utils.ts"] },
    ];
    // A blocks B → different waves
    const result = preflightWorkGroup(tickets, [
      { blocker: "A", blocked: "B" },
    ]);

    expect(result.valid).toBe(true);
    expect(result.fileOverlapWarnings).toHaveLength(0);
  });

  it("cycle returns invalid", () => {
    const tickets = [
      { ticketId: "A", affectedPaths: ["src/a.ts"] },
      { ticketId: "B", affectedPaths: ["src/b.ts"] },
    ];
    const result = preflightWorkGroup(tickets, [
      { blocker: "A", blocked: "B" },
      { blocker: "B", blocked: "A" },
    ]);

    expect(result.valid).toBe(false);
    expect(result.cycleTicketIds).toEqual(expect.arrayContaining(["A", "B"]));
  });

  it("directory prefix overlap detected", () => {
    const tickets = [
      { ticketId: "A", affectedPaths: ["src/tools/"] },
      { ticketId: "B", affectedPaths: ["src/tools/wave-tools.ts"] },
    ];
    // No deps → same wave
    const result = preflightWorkGroup(tickets, []);

    expect(result.valid).toBe(true);
    expect(result.fileOverlapWarnings).toHaveLength(1);
    expect(result.fileOverlapWarnings[0]!.overlappingPaths).toContain(
      "src/tools/wave-tools.ts",
    );
  });
});

// ---------------------------------------------------------------------------
// getReadyTickets
// ---------------------------------------------------------------------------

describe("getReadyTickets", () => {
  // Helper: build a simple two-wave plan where A blocks B
  function twoWavePlan(): WavePlan {
    return {
      waves: [["A"], ["B"]],
      waveCount: 2,
      ticketWaveMap: new Map([
        ["A", 0],
        ["B", 1],
      ]),
      blockers: new Map([["B", ["A"]]]),
    };
  }

  it("wave-0 always ready regardless of statuses", () => {
    const plan = twoWavePlan();
    const statuses = new Map<string, string>();
    // No statuses set at all
    const ready = getReadyTickets(plan, 0, statuses);
    expect(ready).toEqual(["A"]);
  });

  it("wave-1 ready when blockers resolved", () => {
    const plan = twoWavePlan();
    const statuses = new Map([["A", "resolved"]]);
    const ready = getReadyTickets(plan, 1, statuses);
    expect(ready).toEqual(["B"]);
  });

  it("wave-1 blocked when blocker in_progress", () => {
    const plan = twoWavePlan();
    const statuses = new Map([["A", "in_progress"]]);
    const ready = getReadyTickets(plan, 1, statuses);
    expect(ready).toEqual([]);
  });

  it("treats wont_fix as terminal", () => {
    const plan = twoWavePlan();
    const statuses = new Map([["A", "wont_fix"]]);
    const ready = getReadyTickets(plan, 1, statuses);
    expect(ready).toEqual(["B"]);
  });

  it("treats closed as terminal", () => {
    const plan = twoWavePlan();
    const statuses = new Map([["A", "closed"]]);
    const ready = getReadyTickets(plan, 1, statuses);
    expect(ready).toEqual(["B"]);
  });
});
