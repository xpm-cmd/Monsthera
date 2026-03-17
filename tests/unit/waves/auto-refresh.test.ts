import { describe, it, expect } from "vitest";
import {
  placeNewTickets,
  type RefreshCandidate,
  type WaveSlot,
} from "../../../src/waves/auto-refresh.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(
  ticketId: string,
  opts: { paths?: string[]; blockers?: string[] } = {},
): RefreshCandidate {
  return {
    ticketId,
    internalId: Math.floor(Math.random() * 10000),
    affectedPaths: opts.paths ?? [],
    blockerTicketIds: opts.blockers ?? [],
  };
}

function makeSlot(
  waveIndex: number,
  opts: {
    count?: number;
    status?: WaveSlot["status"];
    paths?: string[][];
  } = {},
): WaveSlot {
  return {
    waveIndex,
    currentCount: opts.count ?? 0,
    status: opts.status ?? "pending",
    existingPaths: opts.paths ?? [],
  };
}

// ---------------------------------------------------------------------------
// Basic placement
// ---------------------------------------------------------------------------

describe("placeNewTickets", () => {
  it("returns empty result for no candidates", () => {
    const result = placeNewTickets(
      [],
      [makeSlot(0)],
      0,
      new Set(["existing"]),
      new Map([["existing", 0]]),
      5,
    );

    expect(result.placements.size).toBe(0);
    expect(result.newWavesAppended).toBe(0);
    expect(result.deferred).toHaveLength(0);
  });

  it("places a single candidate into an existing pending wave", () => {
    const result = placeNewTickets(
      [makeCandidate("new-1")],
      [makeSlot(0, { count: 1 }), makeSlot(1, { count: 0 })],
      0,
      new Set(["A"]),
      new Map([["A", 0]]),
      5,
    );

    expect(result.placements.get("new-1")).toBe(0);
    expect(result.newWavesAppended).toBe(0);
  });

  it("respects maxTicketsPerWave — skips full waves", () => {
    const result = placeNewTickets(
      [makeCandidate("new-1")],
      [
        makeSlot(0, { count: 3 }),  // full
        makeSlot(1, { count: 1 }),  // has room
      ],
      0,
      new Set(["A"]),
      new Map([["A", 0]]),
      3, // maxTicketsPerWave = 3
    );

    expect(result.placements.get("new-1")).toBe(1);
    expect(result.newWavesAppended).toBe(0);
  });

  it("skips non-pending waves", () => {
    const result = placeNewTickets(
      [makeCandidate("new-1")],
      [
        makeSlot(0, { count: 0, status: "active" }),
        makeSlot(1, { count: 0, status: "dispatched" }),
        makeSlot(2, { count: 0, status: "pending" }),
      ],
      0,
      new Set(),
      new Map(),
      5,
    );

    expect(result.placements.get("new-1")).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Dependency handling
  // ---------------------------------------------------------------------------

  it("respects convoy dependencies — places after blocker wave", () => {
    const result = placeNewTickets(
      [makeCandidate("new-1", { blockers: ["A"] })],
      [makeSlot(0, { count: 1 }), makeSlot(1, { count: 0 })],
      0,
      new Set(["A"]),
      new Map([["A", 0]]),
      5,
    );

    // A is in wave 0, so new-1 must go to wave >= 1
    expect(result.placements.get("new-1")).toBe(1);
  });

  it("defers tickets with external (non-convoy) blockers", () => {
    const result = placeNewTickets(
      [makeCandidate("new-1", { blockers: ["external-ticket"] })],
      [makeSlot(0, { count: 0 })],
      0,
      new Set(["A"]),
      new Map([["A", 0]]),
      5,
    );

    expect(result.placements.size).toBe(0);
    expect(result.deferred).toContain("new-1");
  });

  it("handles inter-candidate dependencies", () => {
    // new-2 depends on new-1; both are candidates
    const result = placeNewTickets(
      [
        makeCandidate("new-1"),
        makeCandidate("new-2", { blockers: ["new-1"] }),
      ],
      [makeSlot(0, { count: 0 }), makeSlot(1, { count: 0 })],
      0,
      new Set(),
      new Map(),
      5,
    );

    const w1 = result.placements.get("new-1");
    const w2 = result.placements.get("new-2");
    expect(w1).toBeDefined();
    expect(w2).toBeDefined();
    expect(w2!).toBeGreaterThan(w1!);
  });

  // ---------------------------------------------------------------------------
  // File overlap safety
  // ---------------------------------------------------------------------------

  it("skips waves with file overlap", () => {
    const result = placeNewTickets(
      [makeCandidate("new-1", { paths: ["src/shared.ts"] })],
      [
        makeSlot(0, { count: 1, paths: [["src/shared.ts"]] }),
        makeSlot(1, { count: 0, paths: [] }),
      ],
      0,
      new Set(["A"]),
      new Map([["A", 0]]),
      5,
    );

    // Should skip wave 0 (overlap) and go to wave 1
    expect(result.placements.get("new-1")).toBe(1);
  });

  it("detects directory prefix overlap", () => {
    const result = placeNewTickets(
      [makeCandidate("new-1", { paths: ["src/tools/wave.ts"] })],
      [
        makeSlot(0, { count: 1, paths: [["src/tools/"]] }),
        makeSlot(1, { count: 0 }),
      ],
      0,
      new Set(["A"]),
      new Map([["A", 0]]),
      5,
    );

    // src/tools/ overlaps src/tools/wave.ts → skip wave 0
    expect(result.placements.get("new-1")).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Append phase
  // ---------------------------------------------------------------------------

  it("appends new wave when all existing waves are full", () => {
    const result = placeNewTickets(
      [makeCandidate("new-1")],
      [
        makeSlot(0, { count: 2 }),
        makeSlot(1, { count: 2 }),
      ],
      0,
      new Set(),
      new Map(),
      2, // all waves at capacity
    );

    expect(result.placements.get("new-1")).toBe(2);
    expect(result.newWavesAppended).toBe(1);
  });

  it("appends new wave when all pending waves have overlap", () => {
    const result = placeNewTickets(
      [makeCandidate("new-1", { paths: ["src/x.ts"] })],
      [makeSlot(0, { count: 1, paths: [["src/x.ts"]] })],
      0,
      new Set(),
      new Map(),
      5,
    );

    expect(result.placements.get("new-1")).toBe(1);
    expect(result.newWavesAppended).toBe(1);
  });

  it("multiple candidates can share a new appended wave", () => {
    const result = placeNewTickets(
      [
        makeCandidate("new-1", { paths: ["src/a.ts"] }),
        makeCandidate("new-2", { paths: ["src/b.ts"] }),
      ],
      [makeSlot(0, { count: 5 })], // full
      0,
      new Set(),
      new Map(),
      5,
    );

    // Both should go to the same new wave (no overlap between them)
    const w1 = result.placements.get("new-1");
    const w2 = result.placements.get("new-2");
    expect(w1).toBeDefined();
    expect(w2).toBeDefined();
    expect(result.newWavesAppended).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it("handles candidate with no paths (no overlap possible)", () => {
    const result = placeNewTickets(
      [makeCandidate("new-1", { paths: [] })],
      [makeSlot(0, { count: 1, paths: [["src/x.ts"]] })],
      0,
      new Set(),
      new Map(),
      5,
    );

    // No paths → no overlap → should fit in wave 0
    expect(result.placements.get("new-1")).toBe(0);
  });

  it("handles multiple deferred tickets", () => {
    const result = placeNewTickets(
      [
        makeCandidate("d1", { blockers: ["ext-1"] }),
        makeCandidate("d2", { blockers: ["ext-2"] }),
        makeCandidate("ok", { blockers: [] }),
      ],
      [makeSlot(0, { count: 0 })],
      0,
      new Set(),
      new Map(),
      5,
    );

    expect(result.deferred).toEqual(expect.arrayContaining(["d1", "d2"]));
    expect(result.deferred).toHaveLength(2);
    expect(result.placements.has("ok")).toBe(true);
  });

  it("respects deep dependency chain in convoy", () => {
    // Convoy: A(wave0) → B(wave1) → C(wave2)
    // New ticket depends on C → must go to wave >= 3
    const result = placeNewTickets(
      [makeCandidate("new-1", { blockers: ["C"] })],
      [
        makeSlot(0, { count: 1, status: "completed" }),
        makeSlot(1, { count: 1, status: "active" }),
        makeSlot(2, { count: 1, status: "dispatched" }),
        makeSlot(3, { count: 0, status: "pending" }),
      ],
      0,
      new Set(["A", "B", "C"]),
      new Map([["A", 0], ["B", 1], ["C", 2]]),
      5,
    );

    expect(result.placements.get("new-1")).toBe(3);
  });

  it("fills multiple pending waves in order", () => {
    // 3 candidates, 3 pending waves with 1 slot each
    const result = placeNewTickets(
      [
        makeCandidate("n1", { paths: ["src/a.ts"] }),
        makeCandidate("n2", { paths: ["src/b.ts"] }),
        makeCandidate("n3", { paths: ["src/c.ts"] }),
      ],
      [
        makeSlot(0, { count: 1, status: "completed" }),
        makeSlot(1, { count: 0, status: "pending" }),
        makeSlot(2, { count: 0, status: "pending" }),
        makeSlot(3, { count: 0, status: "pending" }),
      ],
      0,
      new Set(),
      new Map(),
      1, // only 1 per wave
    );

    expect(result.placements.get("n1")).toBe(1);
    expect(result.placements.get("n2")).toBe(2);
    expect(result.placements.get("n3")).toBe(3);
    expect(result.newWavesAppended).toBe(0);
  });
});
