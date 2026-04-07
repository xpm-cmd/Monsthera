import { describe, it, expect, beforeEach } from "vitest";
import {
  orchestrationToolDefinitions,
  handleOrchestrationTool,
} from "../../../src/tools/orchestration-tools.js";
import { InMemoryOrchestrationEventRepository } from "../../../src/orchestration/in-memory-repository.js";
import { workId, agentId } from "../../../src/core/types.js";
import type { OrchestrationEvent } from "../../../src/orchestration/repository.js";

// ---------------------------------------------------------------------------
// orchestrationToolDefinitions
// ---------------------------------------------------------------------------

describe("orchestrationToolDefinitions", () => {
  it("returns exactly 2 tools", () => {
    const defs = orchestrationToolDefinitions();
    expect(defs).toHaveLength(2);
  });

  it("each tool has name, description, and inputSchema", () => {
    const defs = orchestrationToolDefinitions();
    for (const def of defs) {
      expect(typeof def.name).toBe("string");
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.inputSchema).toBeDefined();
      expect(def.inputSchema.type).toBe("object");
      expect(typeof def.inputSchema.properties).toBe("object");
    }
  });

  it("tool names match the expected set", () => {
    const names = orchestrationToolDefinitions().map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["log_event", "get_events"]));
  });
});

// ---------------------------------------------------------------------------
// handleOrchestrationTool — log_event
// ---------------------------------------------------------------------------

describe("handleOrchestrationTool — log_event", () => {
  let repo: InMemoryOrchestrationEventRepository;

  beforeEach(() => {
    repo = new InMemoryOrchestrationEventRepository();
  });

  it("logs an event with valid input", async () => {
    const response = await handleOrchestrationTool(
      "log_event",
      {
        workId: "w-test123",
        eventType: "phase_advanced",
        details: { from: "planning", to: "enrichment" },
        agentId: "agent-1",
      },
      repo,
    );
    expect(response.isError).toBeUndefined();
    expect(response.content).toHaveLength(1);
    expect(response.content[0]!.type).toBe("text");
    const event = JSON.parse(response.content[0]!.text) as OrchestrationEvent;
    expect(event.workId).toBe("w-test123");
    expect(event.eventType).toBe("phase_advanced");
    expect(event.agentId).toBe("agent-1");
    expect(event.id).toBeTruthy();
  });

  it("returns error when workId is missing", async () => {
    const response = await handleOrchestrationTool(
      "log_event",
      { eventType: "phase_advanced", details: { foo: "bar" } },
      repo,
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("VALIDATION_FAILED");
    expect(body.message).toContain("workId");
  });

  it("returns error when eventType is missing", async () => {
    const response = await handleOrchestrationTool(
      "log_event",
      { workId: "w-test123", details: { foo: "bar" } },
      repo,
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("VALIDATION_FAILED");
    expect(body.message).toContain("eventType");
  });

  it("returns error when eventType is invalid", async () => {
    const response = await handleOrchestrationTool(
      "log_event",
      { workId: "w-test123", eventType: "not_real_event", details: { foo: "bar" } },
      repo,
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("VALIDATION_FAILED");
    expect(body.message).toContain("not_real_event");
  });

  it("returns error when details is missing", async () => {
    const response = await handleOrchestrationTool(
      "log_event",
      { workId: "w-test123", eventType: "phase_advanced" },
      repo,
    );
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("VALIDATION_FAILED");
    expect(body.message).toContain("details");
  });
});

// ---------------------------------------------------------------------------
// handleOrchestrationTool — get_events
// ---------------------------------------------------------------------------

describe("handleOrchestrationTool — get_events", () => {
  let repo: InMemoryOrchestrationEventRepository;

  beforeEach(async () => {
    repo = new InMemoryOrchestrationEventRepository();
    // Seed several events for filtering tests
    await repo.logEvent({
      workId: workId("w-aaa"),
      eventType: "phase_advanced",
      agentId: agentId("agent-1"),
      details: { from: "planning", to: "enrichment" },
    });
    await repo.logEvent({
      workId: workId("w-bbb"),
      eventType: "agent_spawned",
      agentId: agentId("agent-2"),
      details: { name: "writer" },
    });
    await repo.logEvent({
      workId: workId("w-aaa"),
      eventType: "error_occurred",
      details: { message: "timeout" },
    });
  });

  it("returns events by workId", async () => {
    const response = await handleOrchestrationTool(
      "get_events",
      { workId: "w-aaa" },
      repo,
    );
    expect(response.isError).toBeUndefined();
    const events = JSON.parse(response.content[0]!.text) as OrchestrationEvent[];
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.workId === "w-aaa")).toBe(true);
  });

  it("returns events by eventType", async () => {
    const response = await handleOrchestrationTool(
      "get_events",
      { eventType: "agent_spawned" },
      repo,
    );
    expect(response.isError).toBeUndefined();
    const events = JSON.parse(response.content[0]!.text) as OrchestrationEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe("agent_spawned");
  });

  it("returns recent events when no filter specified", async () => {
    const response = await handleOrchestrationTool("get_events", {}, repo);
    expect(response.isError).toBeUndefined();
    const events = JSON.parse(response.content[0]!.text) as OrchestrationEvent[];
    expect(events).toHaveLength(3);
  });

  it("respects limit parameter", async () => {
    const response = await handleOrchestrationTool(
      "get_events",
      { limit: 1 },
      repo,
    );
    expect(response.isError).toBeUndefined();
    const events = JSON.parse(response.content[0]!.text) as OrchestrationEvent[];
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Unknown tool name
// ---------------------------------------------------------------------------

describe("handleOrchestrationTool — unknown tool", () => {
  it("returns error for unknown tool name", async () => {
    const repo = new InMemoryOrchestrationEventRepository();
    const response = await handleOrchestrationTool("does_not_exist", {}, repo);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toContain("does_not_exist");
  });
});
