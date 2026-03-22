import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadTools } from "../../../src/tools/read-tools.js";

class FakeServer {
  handlers = new Map<string, (input: unknown) => Promise<any>>();

  tool(name: string, _description: string, _schema: object, handler: (input: unknown) => Promise<any>) {
    this.handlers.set(name, handler);
  }
}

describe("analyze_complexity tool", () => {
  let server: FakeServer;
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), "monsthera-complexity-"));
    mkdirSync(join(repoPath, "src"), { recursive: true });
    server = new FakeServer();

    registerReadTools(server as unknown as McpServer, async () => ({
      repoPath,
    } as any));
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  function handler() {
    const found = server.handlers.get("analyze_complexity");
    expect(found).toBeTypeOf("function");
    return found!;
  }

  it("returns complexity metrics for a supported source file", async () => {
    writeFileSync(join(repoPath, "src", "example.ts"), [
      "export function run(value: number) {",
      "  if (value > 0) {",
      "    return value;",
      "  }",
      "  return 0;",
      "}",
    ].join("\n"));

    const result = await handler()({ filePath: "src/example.ts" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({
      filePath: "src/example.ts",
      exists: true,
      supported: true,
      language: "typescript",
      syntaxErrorsPresent: false,
    });
    expect(payload.metrics).toMatchObject({
      functionCount: 1,
      branchPoints: 1,
      maxNesting: 1,
      cyclomaticLike: 2,
    });
    expect(payload.definitions.cyclomaticLike).toContain("1 + branchPoints");
  });

  it("returns a stable unsupported-language payload without throwing", async () => {
    writeFileSync(join(repoPath, "README.md"), "# Monsthera\n");

    const result = await handler()({ filePath: "README.md" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({
      filePath: "README.md",
      exists: true,
      supported: false,
      language: null,
      reason: "unsupported_language",
    });
    expect(payload.metrics).toBeNull();
  });

  it("rejects paths that escape the repo root", async () => {
    await expect(handler()({ filePath: "../outside.ts" })).rejects.toThrow("repo root");
  });
});
