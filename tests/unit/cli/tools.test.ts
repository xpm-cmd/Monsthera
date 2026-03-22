import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InsightStream } from "../../../src/core/insight-stream.js";
import { cmdTool } from "../../../src/cli/tools.js";

function createInsight(): InsightStream {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as InsightStream;
}

describe("tool CLI", () => {
  const config = {
    repoPath: "/repo",
    monstheraDir: ".monsthera",
    dbName: "monsthera.db",
    verbosity: "quiet",
  } as any;

  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exitCode = undefined;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("lists available tools", async () => {
    const insight = createInsight();
    const runner = {
      listTools: () => ["schema", "status"],
      callTool: vi.fn(),
    } as any;

    await cmdTool(config, insight, ["list"], {
      createServer: (() => ({} as any)) as any,
      getRunner: () => runner,
    });

    expect(logSpy).toHaveBeenCalledWith("schema\nstatus");
  });

  it("inspects tools through the schema handler", async () => {
    const insight = createInsight();
    const callTool = vi.fn().mockResolvedValue({
      ok: true,
      tool: "schema",
      result: {
        content: [{
          type: "text",
          text: "{\n  \"tool\": \"status\"\n}",
        }],
      },
    });

    await cmdTool(config, insight, ["inspect", "status"], {
      createServer: (() => ({} as any)) as any,
      getRunner: () => ({
        listTools: () => [],
        callTool,
      } as any),
    });

    expect(callTool).toHaveBeenCalledWith("schema", { toolName: "status" });
    expect(logSpy).toHaveBeenCalledWith("{\n  \"tool\": \"status\"\n}");
  });

  it("passes inline JSON input to the selected tool", async () => {
    const insight = createInsight();
    const callTool = vi.fn().mockResolvedValue({
      ok: true,
      tool: "claim_files",
      result: {
        content: [{
          type: "text",
          text: "{\n  \"claimed\": [\"src/index.ts\"]\n}",
        }],
      },
    });

    await cmdTool(config, insight, [
      "claim_files",
      "--input",
      "{\"agentId\":\"agent-dev\",\"sessionId\":\"session-dev\",\"paths\":[\"src/index.ts\"]}",
    ], {
      createServer: (() => ({} as any)) as any,
      getRunner: () => ({
        listTools: () => [],
        callTool,
      } as any),
    });

    expect(callTool).toHaveBeenCalledWith("claim_files", {
      agentId: "agent-dev",
      sessionId: "session-dev",
      paths: ["src/index.ts"],
    });
    expect(logSpy).toHaveBeenCalledWith("{\n  \"claimed\": [\"src/index.ts\"]\n}");
  });

  it("loads JSON input from a file", async () => {
    const insight = createInsight();
    const callTool = vi.fn().mockResolvedValue({
      ok: true,
      tool: "status",
      result: { content: [{ type: "text", text: "ok" }] },
    });

    await cmdTool(config, insight, [
      "status",
      "--input-file",
      "payload.json",
    ], {
      createServer: (() => ({} as any)) as any,
      getRunner: () => ({
        listTools: () => [],
        callTool,
      } as any),
      readFile: vi.fn().mockResolvedValue("{\"verbose\":true}") as any,
    });

    expect(callTool).toHaveBeenCalledWith("status", { verbose: true });
  });

  it("prints normalized JSON errors and sets a failing exit code", async () => {
    const insight = createInsight();

    await cmdTool(config, insight, ["missing_tool", "--json"], {
      createServer: (() => ({} as any)) as any,
      getRunner: () => ({
        listTools: () => [],
        callTool: vi.fn().mockResolvedValue({
          ok: false,
          tool: "missing_tool",
          errorCode: "tool_not_found",
          message: "Tool not found: missing_tool",
          causeCode: "tool_not_found",
        }),
      } as any),
    });

    expect(process.exitCode).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({
      ok: false,
      tool: "missing_tool",
      errorCode: "tool_not_found",
      message: "Tool not found: missing_tool",
      causeCode: "tool_not_found",
    }, null, 2));
  });
});
