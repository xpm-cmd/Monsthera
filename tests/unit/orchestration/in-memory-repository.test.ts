import { describe, expect, it } from "vitest";
import { agentId, timestamp, workId } from "../../../src/core/types.js";
import { InMemoryOrchestrationEventRepository } from "../../../src/orchestration/in-memory-repository.js";

describe("InMemoryOrchestrationEventRepository.findInWindow", () => {
  async function seed(events: { workId: string; eventType: string; agentId?: string }[]) {
    const repo = new InMemoryOrchestrationEventRepository();
    const logged = [];
    for (const e of events) {
      const r = await repo.logEvent({
        workId: workId(e.workId),
        eventType: e.eventType as "agent_started",
        agentId: e.agentId ? agentId(e.agentId) : undefined,
        details: {},
      });
      if (!r.ok) throw new Error("seed failed");
      logged.push(r.value);
      await new Promise((r) => setTimeout(r, 2));
    }
    return { repo, logged };
  }

  it("returns events whose createdAt is inside [start, end] inclusive", async () => {
    const { repo, logged } = await seed([
      { workId: "w-1", eventType: "agent_started" },
      { workId: "w-2", eventType: "phase_advanced" },
      { workId: "w-3", eventType: "agent_completed" },
    ]);
    const start = logged[0]!.createdAt;
    const end = logged[2]!.createdAt;

    const result = await repo.findInWindow(start, end);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((e) => e.id)).toEqual([logged[0]!.id, logged[1]!.id, logged[2]!.id]);
  });

  it("excludes events outside the window", async () => {
    const { repo, logged } = await seed([
      { workId: "w-pre", eventType: "agent_started" },
      { workId: "w-mid", eventType: "phase_advanced" },
      { workId: "w-post", eventType: "agent_completed" },
    ]);
    const start = logged[1]!.createdAt;
    const end = logged[1]!.createdAt;

    const result = await repo.findInWindow(start, end);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((e) => e.id)).toEqual([logged[1]!.id]);
  });

  it("honors the optional limit, keeping the earliest events", async () => {
    const { repo, logged } = await seed([
      { workId: "w-1", eventType: "agent_started" },
      { workId: "w-2", eventType: "phase_advanced" },
      { workId: "w-3", eventType: "agent_completed" },
    ]);
    const start = logged[0]!.createdAt;
    const end = logged[2]!.createdAt;

    const result = await repo.findInWindow(start, end, 2);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((e) => e.id)).toEqual([logged[0]!.id, logged[1]!.id]);
  });

  it("returns events sorted ascending by createdAt", async () => {
    const repo = new InMemoryOrchestrationEventRepository();
    // log two events very close in time, then sanity check the order
    const a = await repo.logEvent({ workId: workId("w-a"), eventType: "agent_started", details: {} });
    await new Promise((r) => setTimeout(r, 5));
    const b = await repo.logEvent({ workId: workId("w-b"), eventType: "agent_completed", details: {} });
    if (!a.ok || !b.ok) throw new Error("seed failed");

    const result = await repo.findInWindow(a.value.createdAt, b.value.createdAt);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value[0]!.createdAt <= result.value[1]!.createdAt).toBe(true);
  });

  it("returns an empty array when no events fall in the window", async () => {
    const { repo } = await seed([{ workId: "w-1", eventType: "agent_started" }]);
    const future = timestamp("2099-01-01T00:00:00.000Z");
    const farFuture = timestamp("2099-01-02T00:00:00.000Z");

    const result = await repo.findInWindow(future, farFuture);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});
