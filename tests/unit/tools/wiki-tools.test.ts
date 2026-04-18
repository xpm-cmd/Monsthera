import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  wikiToolDefinitions,
  handleWikiTool,
} from "../../../src/tools/wiki-tools.js";
import { WikiBookkeeper } from "../../../src/knowledge/wiki-bookkeeper.js";
import type { Logger } from "../../../src/core/logger.js";

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

describe("wikiToolDefinitions", () => {
  it("returns exactly 2 tools", () => {
    const defs = wikiToolDefinitions();
    expect(defs).toHaveLength(2);
  });

  it("names match the expected set", () => {
    const names = wikiToolDefinitions().map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["get_wiki_index", "get_wiki_log"]));
  });

  it("each tool has a description mentioning when to use it", () => {
    const defs = wikiToolDefinitions();
    for (const def of defs) {
      expect(def.description.length).toBeGreaterThan(40);
      expect(def.description.toLowerCase()).toMatch(/index|log|catalog|mutation/);
    }
  });

  it("get_wiki_log exposes an optional `tail` number argument", () => {
    const def = wikiToolDefinitions().find((d) => d.name === "get_wiki_log");
    expect(def).toBeDefined();
    expect(def!.inputSchema.properties).toHaveProperty("tail");
    expect(def!.inputSchema.required ?? []).not.toContain("tail");
  });
});

describe("handleWikiTool", () => {
  let root: string;
  let bookkeeper: WikiBookkeeper;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `monsthera-wiki-${randomUUID()}`);
    await fs.mkdir(root, { recursive: true });
    bookkeeper = new WikiBookkeeper(root, noopLogger);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("get_wiki_index returns index.md content when present", async () => {
    await fs.writeFile(path.join(root, "index.md"), "# Monsthera Index\n\nHello world\n", "utf-8");
    const response = await handleWikiTool("get_wiki_index", {}, bookkeeper);
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as { content: string; path: string };
    expect(body.content).toContain("Monsthera Index");
    expect(body.path).toMatch(/index\.md$/);
  });

  it("get_wiki_index returns NOT_FOUND when the file does not exist", async () => {
    const response = await handleWikiTool("get_wiki_index", {}, bookkeeper);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("get_wiki_log returns log.md content when present", async () => {
    await bookkeeper.appendLog("create", "knowledge", "First", "k-1");
    await bookkeeper.appendLog("update", "knowledge", "First updated", "k-1");
    const response = await handleWikiTool("get_wiki_log", {}, bookkeeper);
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as { content: string; totalLines: number };
    expect(body.content).toContain("create knowledge | First");
    expect(body.content).toContain("update knowledge | First updated");
    expect(body.totalLines).toBeGreaterThan(0);
  });

  it("get_wiki_log respects the `tail` argument", async () => {
    for (let i = 0; i < 5; i++) {
      await bookkeeper.appendLog("create", "knowledge", `Entry ${i}`, `k-${i}`);
    }
    const response = await handleWikiTool("get_wiki_log", { tail: 2 }, bookkeeper);
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as { content: string };
    expect(body.content).toContain("Entry 3");
    expect(body.content).toContain("Entry 4");
    expect(body.content).not.toContain("Entry 0");
    expect(body.content).not.toContain("Entry 1");
  });

  it("get_wiki_log rejects non-numeric tail", async () => {
    const response = await handleWikiTool("get_wiki_log", { tail: "5" }, bookkeeper);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("VALIDATION_FAILED");
  });

  it("get_wiki_log returns NOT_FOUND when the file does not exist", async () => {
    const response = await handleWikiTool("get_wiki_log", {}, bookkeeper);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("unknown tool name returns NOT_FOUND error", async () => {
    const response = await handleWikiTool("nonexistent", {}, bookkeeper);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });
});
