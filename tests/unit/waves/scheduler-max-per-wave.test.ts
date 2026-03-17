import { describe, it, expect } from "vitest";
import {
  computeWaves,
  preflightWorkGroup,
  type WavePlan,
} from "../../../src/waves/scheduler.js";

describe("computeWaves with maxPerWave", () => {
  it("splits a single large wave into chunks", () => {
    // 6 independent tickets, maxPerWave=2 → 3 waves of 2
    const result = computeWaves(["A", "B", "C", "D", "E", "F"], [], 2);

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    expect(plan.waveCount).toBe(3);
    for (const wave of plan.waves) {
      expect(wave.length).toBeLessThanOrEqual(2);
    }
    // All tickets present
    const allTickets = plan.waves.flat();
    expect(allTickets).toHaveLength(6);
    expect(new Set(allTickets).size).toBe(6);
  });

  it("does not split waves that are already within limit", () => {
    const result = computeWaves(["A", "B"], [], 5);

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    expect(plan.waveCount).toBe(1);
    expect(plan.waves[0]).toHaveLength(2);
  });

  it("splits multiple depth levels independently", () => {
    // A blocks B,C,D,E (4 tickets at depth 1), maxPerWave=2
    const result = computeWaves(
      ["A", "B", "C", "D", "E"],
      [
        { blocker: "A", blocked: "B" },
        { blocker: "A", blocked: "C" },
        { blocker: "A", blocked: "D" },
        { blocker: "A", blocked: "E" },
      ],
      2,
    );

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    // Wave 0: [A] (1 ticket, under limit)
    // Depth 1: [B,C,D,E] splits into [B,C] and [D,E]
    expect(plan.waveCount).toBe(3);
    expect(plan.waves[0]).toEqual(["A"]);
    expect(plan.waves[1]).toHaveLength(2);
    expect(plan.waves[2]).toHaveLength(2);
  });

  it("maxPerWave=1 produces one ticket per wave", () => {
    const result = computeWaves(["A", "B", "C"], [], 1);

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    expect(plan.waveCount).toBe(3);
    for (const wave of plan.waves) {
      expect(wave).toHaveLength(1);
    }
  });

  it("ticketWaveMap is correct after splitting", () => {
    const result = computeWaves(["A", "B", "C", "D"], [], 2);

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    // Each ticket should map to its actual wave index
    for (let w = 0; w < plan.waveCount; w++) {
      for (const tid of plan.waves[w]!) {
        expect(plan.ticketWaveMap.get(tid)).toBe(w);
      }
    }
  });

  it("handles exact multiple (6 tickets, maxPerWave=3)", () => {
    const result = computeWaves(["A", "B", "C", "D", "E", "F"], [], 3);

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    expect(plan.waveCount).toBe(2);
    expect(plan.waves[0]).toHaveLength(3);
    expect(plan.waves[1]).toHaveLength(3);
  });

  it("handles remainder (5 tickets, maxPerWave=3)", () => {
    const result = computeWaves(["A", "B", "C", "D", "E"], [], 3);

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    expect(plan.waveCount).toBe(2);
    expect(plan.waves[0]).toHaveLength(3);
    expect(plan.waves[1]).toHaveLength(2);
  });

  it("undefined maxPerWave keeps original behavior", () => {
    const result = computeWaves(["A", "B", "C", "D"], [], undefined);

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    expect(plan.waveCount).toBe(1);
    expect(plan.waves[0]).toHaveLength(4);
  });

  it("cycle detection still works with maxPerWave", () => {
    const result = computeWaves(
      ["A", "B"],
      [
        { blocker: "A", blocked: "B" },
        { blocker: "B", blocked: "A" },
      ],
      2,
    );

    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toBe("cycle");
    }
  });

  it("empty input returns empty plan with maxPerWave", () => {
    const result = computeWaves([], [], 3);

    expect("error" in result).toBe(false);
    const plan = result as WavePlan;
    expect(plan.waveCount).toBe(0);
    expect(plan.waves).toEqual([]);
  });
});

describe("preflightWorkGroup with maxPerWave", () => {
  it("splits overlapping tickets into separate waves", () => {
    // 3 independent tickets all touching same file, maxPerWave=1
    // Forces each into its own wave, so NO overlaps within any wave
    const tickets = [
      { ticketId: "A", affectedPaths: ["src/shared.ts"] },
      { ticketId: "B", affectedPaths: ["src/shared.ts"] },
      { ticketId: "C", affectedPaths: ["src/shared.ts"] },
    ];
    const result = preflightWorkGroup(tickets, [], 1);

    expect(result.valid).toBe(true);
    expect(result.plan!.waveCount).toBe(3);
    // Each wave has 1 ticket → no intra-wave overlap possible
    expect(result.fileOverlapWarnings).toHaveLength(0);
  });

  it("passes maxPerWave through to computeWaves", () => {
    const tickets = [
      { ticketId: "A", affectedPaths: ["src/a.ts"] },
      { ticketId: "B", affectedPaths: ["src/b.ts"] },
      { ticketId: "C", affectedPaths: ["src/c.ts"] },
      { ticketId: "D", affectedPaths: ["src/d.ts"] },
    ];
    const result = preflightWorkGroup(tickets, [], 2);

    expect(result.valid).toBe(true);
    expect(result.plan!.waveCount).toBe(2);
    expect(result.plan!.waves[0]).toHaveLength(2);
    expect(result.plan!.waves[1]).toHaveLength(2);
  });
});
