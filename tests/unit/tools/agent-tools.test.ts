import { describe, it, expect } from "vitest";
import { agentToolDefinitions, handleAgentTool } from "../../../src/tools/agent-tools.js";
import type { AgentToolDeps } from "../../../src/tools/agent-tools.js";
import { AgentService } from "../../../src/agents/service.js";
import { WorkService } from "../../../src/work/service.js";
import { KnowledgeService } from "../../../src/knowledge/service.js";
import { OrchestrationService } from "../../../src/orchestration/service.js";
import { InMemoryWorkArticleRepository } from "../../../src/work/in-memory-repository.js";
import { InMemoryKnowledgeArticleRepository } from "../../../src/knowledge/in-memory-repository.js";
import { InMemoryOrchestrationEventRepository } from "../../../src/orchestration/in-memory-repository.js";
import { createLogger } from "../../../src/core/logger.js";
import { createStatusReporter } from "../../../src/core/status.js";

async function makeDeps(): Promise<AgentToolDeps & { workService: WorkService }> {
  const logger = createLogger({ level: "warn", domain: "test" });
  const workRepo = new InMemoryWorkArticleRepository();
  const knowledgeRepo = new InMemoryKnowledgeArticleRepository();
  const orchestrationRepo = new InMemoryOrchestrationEventRepository();
  const status = createStatusReporter("3.0.0-test");
  const workService = new WorkService({ workRepo, logger });
  const knowledgeService = new KnowledgeService({ knowledgeRepo, logger });
  const agentsService = new AgentService({ workRepo, orchestrationRepo, logger });
  const orchestrationService = new OrchestrationService({
    workRepo,
    orchestrationRepo,
    logger,
  });
  return {
    agentsService,
    workService,
    knowledgeService,
    orchestrationService,
    status,
    autoAdvanceEnabled: false,
  };
}

describe("agentToolDefinitions", () => {
  it("returns exactly 3 tools", () => {
    const defs = agentToolDefinitions();
    expect(defs).toHaveLength(3);
  });

  it("tool names match the expected set", () => {
    const names = agentToolDefinitions().map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["list_agents", "get_agent", "get_agent_experience"]));
  });

  it("each tool has name, description, and inputSchema", () => {
    for (const def of agentToolDefinitions()) {
      expect(typeof def.name).toBe("string");
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.inputSchema.type).toBe("object");
    }
  });
});

describe("handleAgentTool — list_agents", () => {
  it("returns the directory with summary and agents array", async () => {
    const deps = await makeDeps();
    await deps.workService.createWork({
      title: "Owned work",
      template: "feature",
      priority: "medium",
      author: "agent-alpha",
    });
    const response = await handleAgentTool("list_agents", {}, deps);
    expect(response.isError).toBeFalsy();
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload).toHaveProperty("summary");
    expect(payload).toHaveProperty("agents");
    expect(Array.isArray(payload.agents)).toBe(true);
    const alpha = payload.agents.find((a: { id: string }) => a.id === "agent-alpha");
    expect(alpha).toBeDefined();
    expect(alpha.authoredCount).toBeGreaterThanOrEqual(1);
  });
});

describe("handleAgentTool — get_agent", () => {
  it("returns a profile for a known agent id", async () => {
    const deps = await makeDeps();
    await deps.workService.createWork({
      title: "Profile work",
      template: "feature",
      priority: "medium",
      author: "agent-profile",
    });
    const response = await handleAgentTool(
      "get_agent",
      { id: "agent-profile" },
      deps,
    );
    expect(response.isError).toBeFalsy();
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.id).toBe("agent-profile");
    expect(Array.isArray(payload.touchpoints)).toBe(true);
  });

  it("returns NOT_FOUND for an unknown agent id", async () => {
    const deps = await makeDeps();
    const response = await handleAgentTool(
      "get_agent",
      { id: "agent-does-not-exist" },
      deps,
    );
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.error).toBe("NOT_FOUND");
  });

  it("rejects missing id with VALIDATION_FAILED", async () => {
    const deps = await makeDeps();
    const response = await handleAgentTool("get_agent", {}, deps);
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.error).toBe("VALIDATION_FAILED");
  });
});

describe("handleAgentTool — get_agent_experience", () => {
  it("returns an experience snapshot with scores and recommendations", async () => {
    const deps = await makeDeps();
    await deps.workService.createWork({
      title: "Experience work",
      template: "feature",
      priority: "medium",
      author: "agent-exp",
      content: "## Objective\nShip\n\n## Acceptance Criteria\n- [ ] Done",
    });
    const response = await handleAgentTool("get_agent_experience", {}, deps);
    expect(response.isError).toBeFalsy();
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload).toHaveProperty("scores");
    expect(payload.scores).toHaveProperty("overall");
    expect(payload.scores).toHaveProperty("contract");
    expect(payload.scores).toHaveProperty("context");
    expect(payload.scores).toHaveProperty("ownership");
    expect(payload.scores).toHaveProperty("review");
    expect(payload).toHaveProperty("coverage");
    expect(payload).toHaveProperty("automation");
    expect(payload).toHaveProperty("recommendations");
    expect(Array.isArray(payload.recommendations)).toBe(true);
  });
});

describe("handleAgentTool — unknown tool", () => {
  it("returns NOT_FOUND for unknown tool name", async () => {
    const deps = await makeDeps();
    const response = await handleAgentTool("nonexistent", {}, deps);
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.error).toBe("NOT_FOUND");
  });
});
