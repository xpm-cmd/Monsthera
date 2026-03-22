import { describe, it, expect } from "vitest";
import { CoordinationBus, type MessagePriority } from "../../../src/coordination/bus.js";

describe("CoordinationBus — lanes, priority & backpressure", () => {
  it("filters messages by laneId", () => {
    const bus = new CoordinationBus("hub-spoke");

    bus.send({ from: "a1", to: "a2", type: "status_update", payload: { v: 1 }, laneId: "lane-1" });
    bus.send({ from: "a1", to: "a2", type: "status_update", payload: { v: 2 }, laneId: "lane-2" });
    bus.send({ from: "a1", to: "a2", type: "status_update", payload: { v: 3 }, laneId: null }); // global

    const lane1 = bus.getMessages("a2", undefined, 50, { laneId: "lane-1" });
    // lane-1 messages + global (laneId=null always passes)
    expect(lane1).toHaveLength(2);
    expect(lane1.map((m) => m.payload.v)).toEqual(expect.arrayContaining([1, 3]));
  });

  it("sorts messages by priority (critical > normal > low)", () => {
    const bus = new CoordinationBus("hub-spoke");

    bus.send({ from: "a1", to: "a2", type: "status_update", payload: { p: "low" }, priority: "low" });
    bus.send({ from: "a1", to: "a2", type: "status_update", payload: { p: "critical" }, priority: "critical" });
    bus.send({ from: "a1", to: "a2", type: "status_update", payload: { p: "normal" }, priority: "normal" });

    const msgs = bus.getMessages("a2");
    expect(msgs.map((m) => m.priority)).toEqual(["critical", "normal", "low"]);
  });

  it("filters messages by minPriority", () => {
    const bus = new CoordinationBus("hub-spoke");

    bus.send({ from: "a1", to: "a2", type: "status_update", payload: {}, priority: "low" });
    bus.send({ from: "a1", to: "a2", type: "conflict_alert", payload: {}, priority: "critical" });
    bus.send({ from: "a1", to: "a2", type: "status_update", payload: {}, priority: "normal" });

    const critOnly = bus.getMessages("a2", undefined, 50, { minPriority: "critical" });
    expect(critOnly).toHaveLength(1);
    expect(critOnly[0]!.priority).toBe("critical");

    const normalAndUp = bus.getMessages("a2", undefined, 50, { minPriority: "normal" });
    expect(normalAndUp).toHaveLength(2);
  });

  it("detects backpressure when queue exceeds threshold", () => {
    const bus = new CoordinationBus("hub-spoke", 200, undefined, undefined, {
      maxQueueDepthPerAgent: 3,
    });

    // Send 3 messages — no backpressure yet
    for (let i = 0; i < 3; i++) {
      const result = bus.send({ from: "a1", to: "a2", type: "status_update", payload: { i } });
      expect(result.backpressure).toBe(false);
    }

    // 4th message should trigger backpressure
    const result = bus.send({ from: "a1", to: "a2", type: "status_update", payload: { i: 4 } });
    expect(result.backpressure).toBe(true);
  });

  it("coalesces status_update within time window", () => {
    const bus = new CoordinationBus("hub-spoke", 200, undefined, undefined, {
      coalesceWindowMs: 5000,
    });

    bus.send({ from: "a1", to: null, type: "status_update", payload: { progress: 10 } });
    bus.send({ from: "a1", to: null, type: "status_update", payload: { progress: 50, extra: "data" } });

    const msgs = bus.getMessages("a2");
    // Should be coalesced into a single message
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.payload).toEqual({ progress: 50, extra: "data" });
  });

  it("does NOT coalesce conflict_alert (non-coalesceable type)", () => {
    const bus = new CoordinationBus("hub-spoke", 200, undefined, undefined, {
      coalesceWindowMs: 5000,
    });

    bus.send({ from: "a1", to: null, type: "conflict_alert", payload: { file: "a.ts" } });
    bus.send({ from: "a1", to: null, type: "conflict_alert", payload: { file: "b.ts" } });

    const msgs = bus.getMessages("a2");
    expect(msgs).toHaveLength(2);
  });

  it("does not coalesce messages from different agents", () => {
    const bus = new CoordinationBus("hub-spoke", 200, undefined, undefined, {
      coalesceWindowMs: 5000,
    });

    bus.send({ from: "a1", to: null, type: "status_update", payload: { v: 1 } });
    bus.send({ from: "a2", to: null, type: "status_update", payload: { v: 2 } });

    const msgs = bus.getMessages("a3");
    expect(msgs).toHaveLength(2);
  });

  it("does not coalesce messages in different lanes", () => {
    const bus = new CoordinationBus("hub-spoke", 200, undefined, undefined, {
      coalesceWindowMs: 5000,
    });

    bus.send({ from: "a1", to: null, type: "status_update", payload: { v: 1 }, laneId: "lane-1" });
    bus.send({ from: "a1", to: null, type: "status_update", payload: { v: 2 }, laneId: "lane-2" });

    const msgs = bus.getMessages("a2");
    expect(msgs).toHaveLength(2);
  });

  it("defaults priority to normal and laneId to null", () => {
    const bus = new CoordinationBus("hub-spoke");
    const msg = bus.send({ from: "a1", to: "a2", type: "status_update", payload: {} });

    expect(msg.priority).toBe("normal");
    expect(msg.laneId).toBe(null);
  });
});
