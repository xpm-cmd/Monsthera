import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// Import the manifest
import { CAPABILITY_TOOL_NAMES } from "../../../src/tools/tool-manifest.js";

const TOOLS_DIR = join(import.meta.dirname ?? __dirname, "../../../src/tools");

// Regex to match server.tool("toolName", ...) registrations
// Handles both inline:    server.tool("name", ...)
// and multiline:          server.tool(\n    "name", ...)
const TOOL_PATTERN = /server\.tool\(\s*["']([^"']+)["']/g;

describe("tool manifest lint", () => {
  it("all registered tools appear in manifest and vice versa", () => {
    const registeredTools = new Set<string>();

    for (const file of readdirSync(TOOLS_DIR)) {
      if (
        !file.endsWith(".ts") ||
        file.endsWith(".bak") ||
        file === "tool-manifest.ts" ||
        file === "index.ts" ||
        file === "resolve-agent.ts" ||
        file === "runtime-instrumentation.ts" ||
        file === "tool-runner.ts"
      )
        continue;
      const content = readFileSync(join(TOOLS_DIR, file), "utf-8");
      for (const match of content.matchAll(TOOL_PATTERN)) {
        registeredTools.add(match[1]!);
      }
    }

    const manifestSet = new Set<string>(CAPABILITY_TOOL_NAMES);
    const unregistered = [...registeredTools].filter((t) => !manifestSet.has(t));
    const stale = [...manifestSet].filter((t) => !registeredTools.has(t));

    expect(
      unregistered,
      `Tools registered via server.tool() but NOT in CAPABILITY_TOOL_NAMES: ${unregistered.join(", ")}`,
    ).toEqual([]);
    expect(
      stale,
      `Manifest entries with no matching server.tool() registration: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("manifest has no duplicates", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const name of CAPABILITY_TOOL_NAMES) {
      if (seen.has(name)) duplicates.push(name);
      seen.add(name);
    }
    expect(duplicates, `Duplicate manifest entries: ${duplicates.join(", ")}`).toEqual([]);
  });
});
