import { describe, expect, it } from "vitest";
import { agentId, workId } from "../../../src/core/types.js";
import type { Logger } from "../../../src/core/logger.js";
import { InMemoryConvoyRepository } from "../../../src/orchestration/in-memory-convoy-repository.js";
import { InMemoryOrchestrationEventRepository } from "../../../src/orchestration/in-memory-repository.js";
import {
  convoyToolDefinitions,
  handleConvoyTool,
} from "../../../src/tools/convoy-tools.js";

function silentLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop, child: () => silentLogger() };
}

function deps() {
  const eventRepo = new InMemoryOrchestrationEventRepository();
  const convoyRepo = new InMemoryConvoyRepository({ eventRepo, logger: silentLogger() });
  return { eventRepo, convoyRepo };
}

describe("convoy MCP tools", () => {
  describe("convoy_get", () => {
    it("returns the convoy on success", async () => {
      const { convoyRepo } = deps();
      const created = await convoyRepo.create({
        leadWorkId: workId("w-lead"),
        memberWorkIds: [workId("w-a")],
        goal: "g",
      });
      if (!created.ok) throw new Error("setup failed");

      const response = await handleConvoyTool("convoy_get", { id: created.value.id }, { convoyRepo });
      expect(response.isError).toBeFalsy();
      const text = response.content[0];
      if (!text || text.type !== "text") throw new Error("unexpected response shape");
      const payload = JSON.parse(text.text) as { id: string; status: string };
      expect(payload.id).toBe(created.value.id);
      expect(payload.status).toBe("active");
    });

    it("returns NOT_FOUND for an unknown id", async () => {
      const { convoyRepo } = deps();
      const response = await handleConvoyTool("convoy_get", { id: "cv-doesnt-exist" }, { convoyRepo });
      expect(response.isError).toBe(true);
      const text = response.content[0];
      if (!text || text.type !== "text") throw new Error("unexpected response shape");
      const payload = JSON.parse(text.text) as { error: string; message: string };
      expect(payload.error).toBe("NOT_FOUND");
    });

    it("rejects missing id with VALIDATION_FAILED", async () => {
      const { convoyRepo } = deps();
      const response = await handleConvoyTool("convoy_get", {}, { convoyRepo });
      expect(response.isError).toBe(true);
      const text = response.content[0];
      if (!text || text.type !== "text") throw new Error("unexpected response shape");
      const payload = JSON.parse(text.text) as { error: string };
      expect(payload.error).toBe("VALIDATION_FAILED");
    });
  });

  describe("convoy_create", () => {
    it("propagates actor into the convoy_created event details", async () => {
      const { eventRepo, convoyRepo } = deps();
      const response = await handleConvoyTool(
        "convoy_create",
        {
          leadWorkId: "w-lead",
          memberWorkIds: ["w-a"],
          goal: "g",
          actor: "agent-sarah",
        },
        { convoyRepo },
      );
      expect(response.isError).toBeFalsy();

      const events = await eventRepo.findByType("convoy_created");
      expect(events.ok).toBe(true);
      if (!events.ok) return;
      expect(events.value).toHaveLength(1);
      expect(events.value[0]!.details).toMatchObject({ actor: "agent-sarah" });
    });

    it("rejects when a member already participates in another active convoy", async () => {
      const { convoyRepo } = deps();
      const first = await convoyRepo.create({
        leadWorkId: workId("w-lead-1"),
        memberWorkIds: [workId("w-shared")],
        goal: "first",
      });
      expect(first.ok).toBe(true);

      const response = await handleConvoyTool(
        "convoy_create",
        {
          leadWorkId: "w-lead-2",
          memberWorkIds: ["w-shared"],
          goal: "second",
        },
        { convoyRepo },
      );
      expect(response.isError).toBe(true);
      const text = response.content[0];
      if (!text || text.type !== "text") throw new Error("unexpected response shape");
      const payload = JSON.parse(text.text) as { error: string };
      expect(payload.error).toBe("ALREADY_EXISTS");
    });
  });

  describe("convoy_complete / convoy_cancel", () => {
    it("propagates actor + terminationReason into the terminal events", async () => {
      const { eventRepo, convoyRepo } = deps();
      const created = await convoyRepo.create({
        leadWorkId: workId("w-lead"),
        memberWorkIds: [workId("w-a")],
        goal: "g",
      });
      if (!created.ok) throw new Error("setup failed");

      const response = await handleConvoyTool(
        "convoy_complete",
        {
          id: created.value.id,
          actor: "agent-sarah",
          terminationReason: "lead reached implementation",
        },
        { convoyRepo },
      );
      expect(response.isError).toBeFalsy();

      const events = await eventRepo.findByType("convoy_completed");
      if (!events.ok) throw new Error("event lookup failed");
      expect(events.value).toHaveLength(1);
      expect(events.value[0]!.details).toMatchObject({
        actor: "agent-sarah",
        terminationReason: "lead reached implementation",
      });
    });
  });

  describe("convoyToolDefinitions", () => {
    it("includes convoy_get in the registered tools", () => {
      const defs = convoyToolDefinitions();
      const names = defs.map((d) => d.name);
      expect(names).toContain("convoy_get");
      expect(names).toContain("convoy_create");
      expect(names).toContain("convoy_list");
      expect(names).toContain("convoy_complete");
      expect(names).toContain("convoy_cancel");
    });
  });

  // agentId is imported to keep the type round-trip honest in case future tests need it.
  void agentId;
});
