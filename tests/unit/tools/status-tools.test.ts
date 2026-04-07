import { describe, it, expect } from "vitest";
import {
  statusToolDefinitions,
  handleStatusTool,
} from "../../../src/tools/status-tools.js";
import type { StatusReporter, SystemStatus } from "../../../src/core/status.js";
import { timestamp } from "../../../src/core/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockStatus: StatusReporter = {
  register: () => {},
  unregister: () => {},
  getStatus: (): SystemStatus => ({
    version: "test",
    uptime: 0,
    timestamp: timestamp(),
    subsystems: [],
  }),
};

// ---------------------------------------------------------------------------
// statusToolDefinitions
// ---------------------------------------------------------------------------

describe("statusToolDefinitions", () => {
  it("returns exactly 1 tool", () => {
    const defs = statusToolDefinitions();
    expect(defs).toHaveLength(1);
  });

  it("tool has name 'status', description, and inputSchema", () => {
    const def = statusToolDefinitions()[0]!;
    expect(def.name).toBe("status");
    expect(typeof def.description).toBe("string");
    expect(def.description.length).toBeGreaterThan(0);
    expect(def.inputSchema).toBeDefined();
    expect(def.inputSchema.type).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// handleStatusTool
// ---------------------------------------------------------------------------

describe("handleStatusTool", () => {
  it("returns system status JSON", async () => {
    const response = await handleStatusTool("status", {}, mockStatus);
    expect(response.isError).toBeUndefined();
    expect(response.content).toHaveLength(1);
    expect(response.content[0]!.type).toBe("text");
    const status = JSON.parse(response.content[0]!.text) as SystemStatus;
    expect(status.version).toBe("test");
    expect(status.uptime).toBe(0);
    expect(Array.isArray(status.subsystems)).toBe(true);
  });

  it("returns error for unknown tool name", async () => {
    const response = await handleStatusTool("does_not_exist", {}, mockStatus);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string; message: string };
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toContain("does_not_exist");
  });
});
