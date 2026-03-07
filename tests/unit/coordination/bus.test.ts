import { describe, it, expect, beforeEach } from "vitest";
import { CoordinationBus } from "../../../src/coordination/bus.js";

describe("CoordinationBus", () => {
  let bus: CoordinationBus;

  beforeEach(() => {
    bus = new CoordinationBus("hub-spoke");
  });

  it("sends and retrieves broadcast messages", () => {
    bus.send({ from: "agent-1", to: null, type: "broadcast", payload: { msg: "hello" } });

    const msgs = bus.getMessages("agent-2");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.type).toBe("broadcast");
    expect(msgs[0]!.payload).toEqual({ msg: "hello" });
  });

  it("sends direct messages visible only to sender and target", () => {
    bus.send({ from: "agent-1", to: "agent-2", type: "task_claim", payload: { file: "a.ts" } });

    expect(bus.getMessages("agent-2")).toHaveLength(1);
    expect(bus.getMessages("agent-1")).toHaveLength(1); // sender sees own
    expect(bus.getMessages("agent-3")).toHaveLength(0); // third party doesn't
  });

  it("mesh topology shows all messages to everyone", () => {
    const meshBus = new CoordinationBus("mesh");
    meshBus.send({ from: "agent-1", to: "agent-2", type: "task_claim", payload: {} });

    expect(meshBus.getMessages("agent-3")).toHaveLength(1);
  });

  it("filters by since timestamp", () => {
    // Use a past timestamp so messages created "now" are after it
    const past = new Date(Date.now() - 60_000).toISOString();
    bus.send({ from: "a", to: null, type: "broadcast", payload: { n: 1 } });
    bus.send({ from: "a", to: null, type: "broadcast", payload: { n: 2 } });

    // Both messages should be after 'past'
    const msgs = bus.getMessages("b", past);
    expect(msgs).toHaveLength(2);

    // With no since, all are returned
    expect(bus.getMessages("b")).toHaveLength(2);
  });

  it("trims old messages beyond maxHistory", () => {
    const smallBus = new CoordinationBus("hub-spoke", 5);
    for (let i = 0; i < 10; i++) {
      smallBus.send({ from: "a", to: null, type: "broadcast", payload: { i } });
    }
    expect(smallBus.getMessages("b").length).toBeLessThanOrEqual(5);
  });

  it("reports topology", () => {
    expect(bus.getTopology()).toBe("hub-spoke");
    const meshBus = new CoordinationBus("mesh");
    expect(meshBus.getTopology()).toBe("mesh");
  });
});
