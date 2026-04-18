import { describe, it, expect } from "vitest";
import { waveToolDefinitions, handleWaveTool } from "../../../src/tools/wave-tools.js";
import { OrchestrationService } from "../../../src/orchestration/service.js";
import { InMemoryOrchestrationEventRepository } from "../../../src/orchestration/in-memory-repository.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { WorkService } from "../../../src/work/service.js";
import { createLogger } from "../../../src/core/logger.js";

function makeServices() {
  const workRepo = new InMemoryWorkArticleRepository();
  const orchestrationRepo = new InMemoryOrchestrationEventRepository();
  const logger = createLogger({ level: "warn", domain: "test" });
  const workService = new WorkService({ workRepo, logger });
  const orchestrationService = new OrchestrationService({
    workRepo,
    orchestrationRepo,
    logger,
  });
  return { workRepo, workService, orchestrationService };
}

describe("waveToolDefinitions", () => {
  it("returns exactly 3 tools", () => {
    const defs = waveToolDefinitions();
    expect(defs).toHaveLength(3);
  });

  it("each tool has name, description, and inputSchema", () => {
    for (const def of waveToolDefinitions()) {
      expect(typeof def.name).toBe("string");
      expect(def.name.length).toBeGreaterThan(0);
      expect(typeof def.description).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.inputSchema.type).toBe("object");
    }
  });

  it("tool names match the expected set", () => {
    const names = waveToolDefinitions().map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["plan_wave", "execute_wave", "evaluate_readiness"]));
  });
});

describe("handleWaveTool — plan_wave", () => {
  it("returns ready and blocked items with enriched titles and priorities", async () => {
    const { workService, orchestrationService } = makeServices();
    const created = await workService.createWork({
      title: "Ready feature",
      template: "feature",
      priority: "high",
      author: "agent-1",
      content: "## Objective\nDeliver feature\n\n## Acceptance Criteria\n- [ ] Done",
    });
    expect(created.ok).toBe(true);

    const response = await handleWaveTool("plan_wave", {}, orchestrationService, workService);
    expect(response.isError).toBeFalsy();
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload).toHaveProperty("ready");
    expect(payload).toHaveProperty("blocked");
    expect(payload).toHaveProperty("summary");
    expect(payload.summary.readyCount).toBeGreaterThanOrEqual(1);
    const readyItem = payload.ready.find((item: { title: string }) => item.title === "Ready feature");
    expect(readyItem).toBeDefined();
    expect(readyItem.from).toBe("planning");
    expect(readyItem.to).toBe("enrichment");
    expect(readyItem.priority).toBe("high");
    expect(readyItem.template).toBe("feature");
  });

  it("respects autoAdvanceOnly filter", async () => {
    const { workService, orchestrationService } = makeServices();
    const spike = await workService.createWork({
      title: "Spike only",
      template: "spike",
      priority: "low",
      author: "agent-1",
      content: "## Objective\nExplore\n\n## Acceptance Criteria\n- [ ] Summarize",
    });
    expect(spike.ok).toBe(true);

    const unfiltered = await handleWaveTool("plan_wave", {}, orchestrationService, workService);
    const filtered = await handleWaveTool(
      "plan_wave",
      { autoAdvanceOnly: true },
      orchestrationService,
      workService,
    );
    const unfilteredPayload = JSON.parse(unfiltered.content[0]!.text);
    const filteredPayload = JSON.parse(filtered.content[0]!.text);
    expect(filteredPayload.autoAdvanceOnly).toBe(true);
    expect(unfilteredPayload.autoAdvanceOnly).toBe(false);
  });
});

describe("handleWaveTool — execute_wave", () => {
  it("advances ready articles and returns per-item outcomes", async () => {
    const { workService, orchestrationService } = makeServices();
    const created = await workService.createWork({
      title: "To advance",
      template: "feature",
      priority: "high",
      author: "agent-1",
      content: "## Objective\nShip it\n\n## Acceptance Criteria\n- [ ] Done",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const response = await handleWaveTool(
      "execute_wave",
      {},
      orchestrationService,
      workService,
    );
    expect(response.isError).toBeFalsy();
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.summary.advancedCount).toBeGreaterThanOrEqual(1);
    const advancedIds = payload.advanced.map((item: { workId: string }) => item.workId);
    expect(advancedIds).toContain(created.value.id);
  });
});

describe("handleWaveTool — evaluate_readiness", () => {
  it("returns ready=true when guards pass", async () => {
    const { workService, orchestrationService } = makeServices();
    const created = await workService.createWork({
      title: "Ready article",
      template: "feature",
      priority: "medium",
      author: "agent-1",
      content: "## Objective\nShip\n\n## Acceptance Criteria\n- [ ] Done",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const response = await handleWaveTool(
      "evaluate_readiness",
      { workId: created.value.id },
      orchestrationService,
      workService,
    );
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.workId).toBe(created.value.id);
    expect(payload.ready).toBe(true);
    expect(payload.nextPhase).toBe("enrichment");
    expect(payload.guardResults).toBeInstanceOf(Array);
  });

  it("returns ready=false with guardResults when guards fail", async () => {
    const { workService, orchestrationService } = makeServices();
    const created = await workService.createWork({
      title: "Missing criteria",
      template: "feature",
      priority: "medium",
      author: "agent-1",
      content: "Body with no sections.",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const response = await handleWaveTool(
      "evaluate_readiness",
      { workId: created.value.id },
      orchestrationService,
      workService,
    );
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.ready).toBe(false);
    const failed = payload.guardResults.filter((g: { passed: boolean }) => !g.passed);
    expect(failed.length).toBeGreaterThan(0);
  });

  it("rejects missing workId with VALIDATION_FAILED", async () => {
    const { workService, orchestrationService } = makeServices();
    const response = await handleWaveTool(
      "evaluate_readiness",
      {},
      orchestrationService,
      workService,
    );
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.error).toBe("VALIDATION_FAILED");
  });

  it("returns NOT_FOUND for a missing workId", async () => {
    const { workService, orchestrationService } = makeServices();
    const response = await handleWaveTool(
      "evaluate_readiness",
      { workId: "w-does-not-exist" },
      orchestrationService,
      workService,
    );
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.error).toBe("NOT_FOUND");
  });
});

describe("handleWaveTool — unknown tool", () => {
  it("returns NOT_FOUND for unknown tool name", async () => {
    const { workService, orchestrationService } = makeServices();
    const response = await handleWaveTool(
      "nonexistent_tool",
      {},
      orchestrationService,
      workService,
    );
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.error).toBe("NOT_FOUND");
  });
});
