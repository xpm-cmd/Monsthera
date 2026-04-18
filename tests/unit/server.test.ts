import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildToolRegistry, dispatchToolCall } from "../../src/server.js";
import { createTestContainer } from "../../src/core/container.js";
import type { MonstheraContainer } from "../../src/core/container.js";

/**
 * Server tests exercise the pure-function core of the MCP server —
 * buildToolRegistry and dispatchToolCall — without spinning up stdio.
 * startServer itself is a thin wrapper over the MCP SDK.
 */

let container: MonstheraContainer;

beforeEach(async () => {
  container = await createTestContainer();
});

afterEach(async () => {
  await container.dispose();
});

describe("buildToolRegistry", () => {
  it("returns definitions from every tool group", () => {
    const reg = buildToolRegistry(container);
    const defNames = reg.definitions.map((d) => d.name);
    expect(defNames).toContain("create_article"); // knowledge
    expect(defNames).toContain("create_work"); // work
    expect(defNames).toContain("search"); // search
    expect(defNames).toContain("get_wiki_index"); // wiki
    expect(defNames).toContain("status"); // status
  });

  it("has no duplicate tool names across groups", () => {
    const reg = buildToolRegistry(container);
    const names = reg.definitions.map((d) => d.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("every definition carries a non-empty description and object schema", () => {
    const reg = buildToolRegistry(container);
    for (const def of reg.definitions) {
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.inputSchema.type).toBe("object");
    }
  });

  it("partitions names into non-overlapping per-group sets", () => {
    const reg = buildToolRegistry(container);
    const groups = Object.values(reg.names);
    const total = groups.reduce((sum, g) => sum + g.size, 0);
    const merged = new Set<string>();
    for (const group of groups) {
      for (const n of group) merged.add(n);
    }
    expect(merged.size).toBe(total);
  });

  it("wiki group registers get_wiki_index and get_wiki_log", () => {
    const reg = buildToolRegistry(container);
    expect(reg.names.wiki.has("get_wiki_index")).toBe(true);
    expect(reg.names.wiki.has("get_wiki_log")).toBe(true);
  });

  it("migration tools are excluded when migrationService is not wired", () => {
    const reg = buildToolRegistry(container);
    expect(reg.names.migration.size).toBe(0);
  });

  it("migration tools are included when migrationService is wired", () => {
    const fakeMigrationService = {
      importAll: () => Promise.resolve({ ok: true as const, value: null }),
    };
    const withMigration: MonstheraContainer = {
      ...container,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      migrationService: fakeMigrationService as any,
    };
    const reg = buildToolRegistry(withMigration);
    expect(reg.names.migration.size).toBeGreaterThan(0);
  });
});

describe("dispatchToolCall", () => {
  it("dispatches a knowledge tool call to the knowledge handler", async () => {
    const response = await dispatchToolCall(
      "create_article",
      { title: "Dispatched Article", category: "engineering", content: "body" },
      container,
    );
    expect(response.isError).toBeUndefined();
    const parsed = JSON.parse(response.content[0]!.text) as { id: string; title: string };
    expect(parsed.title).toBe("Dispatched Article");
    expect(parsed.id).toBeTruthy();
  });

  it("dispatches a work tool call to the work handler", async () => {
    const response = await dispatchToolCall(
      "create_work",
      {
        title: "Dispatched Work",
        template: "feature",
        priority: "medium",
        author: "agent-1",
      },
      container,
    );
    expect(response.isError).toBeUndefined();
    const parsed = JSON.parse(response.content[0]!.text) as { id: string; title: string };
    expect(parsed.title).toBe("Dispatched Work");
  });

  it("dispatches a status tool call to the status handler", async () => {
    const response = await dispatchToolCall("status", {}, container);
    expect(response.isError).toBeUndefined();
    const parsed = JSON.parse(response.content[0]!.text) as { version: string };
    expect(parsed.version).toBeTruthy();
  });

  it("dispatches a wiki tool call even when the index has not been written", async () => {
    // Fresh container has no knowledge yet -> index.md does not exist.
    const response = await dispatchToolCall("get_wiki_index", {}, container);
    expect(response.isError).toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { error: string };
    expect(body.error).toBe("NOT_FOUND");
  });

  it("dispatches a search tool call and returns a slim context pack by default", async () => {
    await dispatchToolCall(
      "create_article",
      { title: "Auth Guide", category: "guide", content: "Auth walkthrough" },
      container,
    );
    const response = await dispatchToolCall(
      "build_context_pack",
      { query: "auth", mode: "code" },
      container,
    );
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as {
      items: Array<{ id: string; content?: unknown }>;
    };
    expect(body.items[0]?.content).toBeUndefined();
  });

  it("search dispatch threads knowledge/work repos through to include_content", async () => {
    await dispatchToolCall(
      "create_article",
      { title: "Payments Content Test", category: "guide", content: "Full body here." },
      container,
    );
    const response = await dispatchToolCall(
      "build_context_pack",
      { query: "payments", mode: "code", include_content: true },
      container,
    );
    expect(response.isError).toBeUndefined();
    const body = JSON.parse(response.content[0]!.text) as {
      items: Array<{ id: string; content?: string }>;
    };
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items[0]?.content).toBe("Full body here.");
  });

  it("returns an error response for an unknown tool (not a thrown exception)", async () => {
    const response = await dispatchToolCall("never_registered_tool", {}, container);
    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain("Unknown tool");
  });

  it("reindex_all triggers a wiki index rebuild alongside the search reindex", async () => {
    await dispatchToolCall(
      "create_article",
      {
        title: "Reindex Article",
        category: "engineering",
        content: "Reindex me please",
      },
      container,
    );
    const response = await dispatchToolCall("reindex_all", {}, container);
    expect(response.isError).toBeUndefined();
    const indexResponse = await dispatchToolCall("get_wiki_index", {}, container);
    expect(indexResponse.isError).toBeUndefined();
    const parsed = JSON.parse(indexResponse.content[0]!.text) as { content: string };
    expect(parsed.content).toContain("Monsthera Index");
    expect(parsed.content).toContain("Reindex Article");
  });
});
