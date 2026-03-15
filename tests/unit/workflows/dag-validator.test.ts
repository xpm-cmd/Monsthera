import { describe, expect, it } from "vitest";
import { validateDAG } from "../../../src/workflows/dag-validator.js";

describe("validateDAG", () => {
  it("accepts an empty graph", () => {
    const result = validateDAG([], 3);
    expect(result.valid).toBe(true);
    expect(result.topologicalOrder).toHaveLength(3);
  });

  it("accepts a valid DAG", () => {
    // 0 -> 1 -> 2
    const result = validateDAG(
      [
        { from: 0, to: 1 },
        { from: 1, to: 2 },
      ],
      3,
    );
    expect(result.valid).toBe(true);
    expect(result.topologicalOrder).toEqual([0, 1, 2]);
  });

  it("accepts a diamond DAG", () => {
    // 0 -> 1, 0 -> 2, 1 -> 3, 2 -> 3
    const result = validateDAG(
      [
        { from: 0, to: 1 },
        { from: 0, to: 2 },
        { from: 1, to: 3 },
        { from: 2, to: 3 },
      ],
      4,
    );
    expect(result.valid).toBe(true);
    expect(result.topologicalOrder).toBeDefined();
    // 0 must come before 1, 2; both must come before 3
    const order = result.topologicalOrder!;
    expect(order.indexOf(0)).toBeLessThan(order.indexOf(1));
    expect(order.indexOf(0)).toBeLessThan(order.indexOf(2));
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(3));
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(3));
  });

  it("detects a simple cycle", () => {
    // 0 -> 1 -> 0
    const result = validateDAG(
      [
        { from: 0, to: 1 },
        { from: 1, to: 0 },
      ],
      2,
    );
    expect(result.valid).toBe(false);
    expect(result.cycleNodes).toEqual(expect.arrayContaining([0, 1]));
  });

  it("detects a 3-node cycle", () => {
    // 0 -> 1 -> 2 -> 0
    const result = validateDAG(
      [
        { from: 0, to: 1 },
        { from: 1, to: 2 },
        { from: 2, to: 0 },
      ],
      3,
    );
    expect(result.valid).toBe(false);
    expect(result.cycleNodes).toHaveLength(3);
  });

  it("rejects out-of-bounds indices", () => {
    const result = validateDAG(
      [{ from: 0, to: 5 }],
      3,
    );
    expect(result.valid).toBe(false);
    expect(result.boundsErrors).toBeDefined();
    expect(result.boundsErrors).toHaveLength(1);
    expect(result.boundsErrors![0]!.invalidDep).toBe(5);
  });

  it("rejects negative indices", () => {
    const result = validateDAG(
      [{ from: -1, to: 0 }],
      2,
    );
    expect(result.valid).toBe(false);
    expect(result.boundsErrors).toBeDefined();
  });

  it("handles a single node with no edges", () => {
    const result = validateDAG([], 1);
    expect(result.valid).toBe(true);
    expect(result.topologicalOrder).toEqual([0]);
  });

  it("handles disconnected components", () => {
    // 0 -> 1, 2 -> 3 (two separate chains)
    const result = validateDAG(
      [
        { from: 0, to: 1 },
        { from: 2, to: 3 },
      ],
      4,
    );
    expect(result.valid).toBe(true);
    expect(result.topologicalOrder).toHaveLength(4);
  });
});
